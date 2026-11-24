// GlassCore hardware helper — the on-demand privileged broker.
//
// Security model (see docs/SECURITY-MODEL.md):
//  * Named pipe restricted to the launching user's SID; first message must carry the
//    per-install token from %LOCALAPPDATA%\GlassCore\broker.token (user-only ACL).
//  * Fixed allowlist of operations. No arbitrary command execution, file writes or
//    registry edits. Every operation is logged to the audit file.
//  * Watchdog: if the client goes quiet for 15 s or disconnects, all fans are handed
//    back to BIOS control and the helper exits.

using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace GlassCore.Broker;

public static class Program
{
    static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "GlassCore");
    static readonly string LogPath = Path.Combine(Dir, "broker-audit.log");
    static DateTime _lastPing = DateTime.UtcNow;
    static Fans? _fans;
    static Aura? _aura;

    public static int Main(string[] args)
    {
        Directory.CreateDirectory(Dir);
        AppDomain.CurrentDomain.UnhandledException += (_, e) => { Log("crash", e.ExceptionObject?.ToString() ?? ""); _fans?.ReleaseAll(); };

        string? tokenFile = null;
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "--token-file") tokenFile = args[i + 1];
        tokenFile ??= Path.Combine(Dir, "broker.token");
        if (!File.Exists(tokenFile)) { Log("start", "no token file — exiting"); return 2; }
        var token = File.ReadAllText(tokenFile).Trim();
        if (token.Length < 32) { Log("start", "token too short — exiting"); return 2; }

        var sessionId = System.Diagnostics.Process.GetCurrentProcess().SessionId;
        var pipeName = $"glasscore-broker-{sessionId}";
        var owner = WindowsIdentity.GetCurrent().User!;
        bool elevated = new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator);
        Log("start", $"elevated={elevated}");

        using var mutex = new Mutex(true, $"Local\\GlassCoreBroker{sessionId}", out bool first);
        if (!first) { Log("start", "already running"); return 0; }

        _fans = new Fans(Log);
        _aura = new Aura(Log);

        // Watchdog thread.
        new Thread(() =>
        {
            while (true)
            {
                Thread.Sleep(1000);
                if ((DateTime.UtcNow - _lastPing).TotalSeconds > 15 && _fans.HasOverrides)
                {
                    Log("watchdog", "client silent >15s — returning fans to BIOS");
                    _fans.ReleaseAll();
                }
                if ((DateTime.UtcNow - _lastPing).TotalMinutes > 5)
                {
                    Log("watchdog", "idle >5 min — exiting");
                    _fans.ReleaseAll(); _aura.Release();
                    Environment.Exit(0);
                }
            }
        }) { IsBackground = true }.Start();

        while (true)
        {
            var sec = new PipeSecurity();
            sec.AddAccessRule(new PipeAccessRule(owner, PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance, AccessControlType.Allow));
            using var server = NamedPipeServerStreamAcl.Create(pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.None, 65536, 65536, sec);
            server.WaitForConnection();
            _lastPing = DateTime.UtcNow;
            try { Serve(server, token, elevated); }
            catch (Exception ex) { Log("pipe", ex.Message); }
            // Client went away: be safe.
            _fans.ReleaseAll();
        }
    }

    static void Serve(NamedPipeServerStream pipe, string token, bool elevated)
    {
        using var reader = new StreamReader(pipe, new UTF8Encoding(false), false, 65536, leaveOpen: true);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 65536, leaveOpen: true) { AutoFlush = true, NewLine = "\n" };
        bool authed = false;
        string? line;
        while ((line = reader.ReadLine()) != null)
        {
            JsonNode? req;
            try { req = JsonNode.Parse(line); } catch { break; }
            var id = req?["id"]?.GetValue<long>() ?? 0;
            var method = req?["method"]?.GetValue<string>() ?? "";
            var p = req?["params"] as JsonObject ?? new JsonObject();
            if (!authed)
            {
                if (method == "hello" && CryptoEquals(p["token"]?.GetValue<string>() ?? "", token))
                {
                    authed = true;
                    writer.WriteLine(Ok(id, new JsonObject { ["elevated"] = elevated, ["version"] = "0.1.0" }));
                    continue;
                }
                Log("auth", "bad token — closing");
                return;
            }
            _lastPing = DateTime.UtcNow;
            string resp;
            try { resp = Ok(id, Dispatch(method, p, elevated)); }
            catch (Exception ex) { resp = Err(id, ex.Message); }
            writer.WriteLine(resp);
        }
    }

    static JsonNode? Dispatch(string method, JsonObject p, bool elevated)
    {
        switch (method)
        {
            case "ping": return "pong";
            case "hw.snapshot": return _fans!.Snapshot();
            case "fan.apply":
                Need(elevated);
                _fans!.Apply(p);
                Log("fan.apply", p.ToJsonString());
                return true;
            case "fan.release":
                _fans!.ReleaseAll();
                Log("fan.release", "all");
                return true;
            case "aura.devices": return _aura!.Devices();
            case "aura.set":
                Need(elevated);
                _aura!.Set(p["device"]!.GetValue<int>(), p["colors"]!.AsArray().Select(c => c!.GetValue<uint>()).ToArray());
                return true;
            case "aura.release": _aura!.Release(); return true;
            case "svc.control":
            {
                Need(elevated);
                var name = p["name"]!.GetValue<string>();
                var action = p["action"]!.GetValue<string>();
                var r = Privileged.ServiceControl(name, action);
                Log("svc.control", $"{name} {action} -> {r}");
                return r;
            }
            case "svc.starttype":
            {
                Need(elevated);
                var name = p["name"]!.GetValue<string>();
                var type = p["type"]!.GetValue<string>();
                var r = Privileged.ServiceStartType(name, type);
                Log("svc.starttype", $"{name} {type} -> {r}");
                return r;
            }
            case "proc.kill":
            {
                Need(elevated);
                var pid = p["pid"]!.GetValue<int>();
                var created = p["created"]?.GetValue<long>();
                var r = Privileged.Kill(pid, created);
                Log("proc.kill", $"{pid} -> {r}");
                return r;
            }
            case "task.helper":
            {
                Need(elevated);
                var enable = p["enable"]!.GetValue<bool>();
                var r = Privileged.HelperLogonTask(enable);
                Log("task.helper", $"{enable} -> {r}");
                return r;
            }
            case "shutdown":
                _fans!.ReleaseAll(); _aura!.Release();
                Log("shutdown", "requested");
                new Thread(() => { Thread.Sleep(200); Environment.Exit(0); }).Start();
                return true;
            default:
                throw new InvalidOperationException($"'{method}' is not an allowed operation");
        }
    }

    static void Need(bool elevated)
    {
        if (!elevated) throw new UnauthorizedAccessException("The hardware helper isn't running as administrator");
    }

    static bool CryptoEquals(string a, string b)
    {
        var x = Encoding.UTF8.GetBytes(a); var y = Encoding.UTF8.GetBytes(b);
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(x, y);
    }

    static string Ok(long id, JsonNode? result) => new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = result }.ToJsonString();
    static string Err(long id, string msg) => new JsonObject { ["id"] = id, ["ok"] = false, ["error"] = msg }.ToJsonString();

    public static void Log(string action, string detail)
    {
        try
        {
            var fi = new FileInfo(LogPath);
            if (fi.Exists && fi.Length > 2_000_000) File.Move(LogPath, LogPath + ".1", true);
            File.AppendAllText(LogPath, $"{DateTime.Now:O}\t{action}\t{detail}\n");
        }
        catch { }
    }
}
