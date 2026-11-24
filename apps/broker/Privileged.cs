// Narrow, allow-listed privileged operations.

using System.Diagnostics;
using System.ServiceProcess;

namespace GlassCore.Broker;

public static class Privileged
{
    // Never touch these, even elevated (PRIVACY-07).
    static readonly string[] ProtectedServices =
    {
        "RpcSs", "RpcEptMapper", "DcomLaunch", "LSM", "SamSs", "EventLog", "Winmgmt", "WinDefend",
        "WdNisSvc", "SecurityHealthService", "mpssvc", "BFE", "CryptSvc", "Schedule", "gpsvc", "Power",
        "PlugPlay", "ProfSvc", "CoreMessagingRegistrar", "BrokerInfrastructure", "SystemEventsBroker",
    };

    static readonly string[] ProtectedProcesses =
    {
        "system", "registry", "smss", "csrss", "wininit", "services", "lsass", "winlogon", "lsaiso",
        "memory compression", "secure system", "fontdrvhost", "dwm", "svchost", "msmpeng",
    };

    public static string ServiceControl(string name, string action)
    {
        if (ProtectedServices.Contains(name, StringComparer.OrdinalIgnoreCase)) return "refused: protected system service";
        using var sc = new ServiceController(name);
        switch (action)
        {
            case "start":
                if (sc.Status != ServiceControllerStatus.Running) { sc.Start(); sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20)); }
                return "running";
            case "stop":
                if (sc.Status != ServiceControllerStatus.Stopped) { sc.Stop(); sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20)); }
                return "stopped";
            case "restart":
                if (sc.Status != ServiceControllerStatus.Stopped) { sc.Stop(); sc.WaitForStatus(ServiceControllerStatus.Stopped, TimeSpan.FromSeconds(20)); }
                sc.Start(); sc.WaitForStatus(ServiceControllerStatus.Running, TimeSpan.FromSeconds(20));
                return "running";
            default: throw new ArgumentException("unknown action");
        }
    }

    public static string ServiceStartType(string name, string type)
    {
        if (ProtectedServices.Contains(name, StringComparer.OrdinalIgnoreCase)) return "refused: protected system service";
        var mode = type switch { "auto" => "auto", "delayed" => "delayed-auto", "manual" => "demand", "disabled" => "disabled", _ => throw new ArgumentException("bad type") };
        // sc.exe is the supported tool; arguments are fixed tokens, the service name is validated.
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z0-9_.\\-]{1,80}$")) throw new ArgumentException("bad service name");
        var psi = new ProcessStartInfo("sc.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
        psi.ArgumentList.Add("config"); psi.ArgumentList.Add(name); psi.ArgumentList.Add("start="); psi.ArgumentList.Add(mode);
        using var p = Process.Start(psi)!;
        p.WaitForExit(10000);
        return p.ExitCode == 0 ? "ok" : $"sc.exe exit {p.ExitCode}";
    }

    public static string Kill(int pid, long? created)
    {
        using var p = Process.GetProcessById(pid);
        if (pid <= 4 || ProtectedProcesses.Contains(p.ProcessName.ToLowerInvariant())) return "refused: protected process";
        if (created.HasValue && p.StartTime.ToFileTimeUtc() != created.Value) return "refused: PID was reused by another process";
        p.Kill();
        return "terminated";
    }

    /// Opt-in: start the helper elevated at sign-in without a UAC prompt.
    public static string HelperLogonTask(bool enable)
    {
        var exe = Environment.ProcessPath!;
        var psi = new ProcessStartInfo("schtasks.exe") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
        if (enable)
        {
            foreach (var a in new[] { "/Create", "/TN", "GlassCore Hardware Helper", "/TR", $"\"{exe}\"", "/SC", "ONLOGON", "/RL", "HIGHEST", "/DELAY", "0000:15", "/F" }) psi.ArgumentList.Add(a);
        }
        else
        {
            foreach (var a in new[] { "/Delete", "/TN", "GlassCore Hardware Helper", "/F" }) psi.ArgumentList.Add(a);
        }
        using var p = Process.Start(psi)!;
        p.WaitForExit(10000);
        return p.ExitCode == 0 ? "ok" : $"schtasks exit {p.ExitCode}";
    }
}
