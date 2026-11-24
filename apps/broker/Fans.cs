// Sensors and fan control (FR-07) on top of LibreHardwareMonitor.
//
// Safety invariants:
//  * Only PWM controls LibreHardwareMonitor reports as controllable are ever written.
//  * Minimum duty floor per fan (CPU / pump headers never below 30%).
//  * Curves: hysteresis + step-up/step-down ramp limits (prevents oscillation).
//  * Stale or missing source sensor for >10 s -> that fan returns to BIOS control.
//  * CPU or GPU >= 90 °C -> every managed fan goes to 100% until it cools by 5 °C.
//  * ReleaseAll() on exit, crash, watchdog or client disconnect.

using System.Text.Json.Nodes;
using LibreHardwareMonitor.Hardware;

namespace GlassCore.Broker;

public sealed class Fans
{
    sealed class Profile
    {
        public string Mode = "auto";      // auto | fixed | curve
        public double Percent = 60;
        public List<(double t, double p)> Curve = new() { (30, 30), (50, 45), (70, 75), (85, 100) };
        public string Source = "cpu";     // cpu | gpu | max
        public double Hysteresis = 3;     // °C
        public double StepUp = 8;         // %/s
        public double StepDown = 3;       // %/s
        public double Floor = 20;
        // runtime
        public double Current = -1;
        public double LastTemp = double.NaN;
        public DateTime LastFresh = DateTime.UtcNow;
    }

    readonly Computer _pc;
    readonly object _lock = new();
    readonly Dictionary<string, ISensor> _controls = new();
    readonly Dictionary<string, Profile> _profiles = new();
    readonly HashSet<string> _overridden = new();
    readonly Action<string, string> _log;
    bool _emergency;
    JsonObject _last = new();
    string? _error;

    public bool HasOverrides { get { lock (_lock) return _overridden.Count > 0; } }

    public Fans(Action<string, string> log)
    {
        _log = log;
        _pc = new Computer { IsMotherboardEnabled = true, IsControllerEnabled = true, IsCpuEnabled = true, IsGpuEnabled = true, IsStorageEnabled = true, IsMemoryEnabled = true };
        try { _pc.Open(); }
        catch (Exception ex) { _error = "Sensor driver failed to load: " + ex.Message; }
        new Thread(Loop) { IsBackground = true, Name = "fans" }.Start();
    }

    static IEnumerable<IHardware> All(IEnumerable<IHardware> hw)
    {
        foreach (var h in hw) { yield return h; foreach (var s in All(h.SubHardware)) yield return s; }
    }

    static double Floor(string name) =>
        name.Contains("CPU", StringComparison.OrdinalIgnoreCase) || name.Contains("Pump", StringComparison.OrdinalIgnoreCase) || name.Contains("AIO", StringComparison.OrdinalIgnoreCase) ? 30 : 20;

    void Loop()
    {
        while (true)
        {
            try { Tick(); } catch (Exception ex) { _error = ex.Message; }
            Thread.Sleep(1000);
        }
    }

    void Tick()
    {
        var hw = All(_pc.Hardware).ToList();
        foreach (var h in hw) h.Update();

        double? cpuT = null, gpuT = null;
        var temps = new JsonArray();
        var fans = new JsonArray();
        var other = new JsonArray();
        foreach (var h in hw)
        {
            foreach (var s in h.Sensors.Where(s => s.SensorType == SensorType.Temperature && s.Value is > 0 and < 150))
            {
                temps.Add(new JsonObject { ["hw"] = h.Name, ["kind"] = h.HardwareType.ToString(), ["name"] = s.Name, ["value"] = Math.Round((double)s.Value!, 1) });
                if (h.HardwareType == HardwareType.Cpu && (s.Name.Contains("Package") || s.Name.Contains("Tctl") || (cpuT == null && s.Name.Contains("Core Max"))))
                    cpuT = s.Value;
                if (h.HardwareType.ToString().StartsWith("Gpu") && (s.Name == "GPU Core" || gpuT == null))
                    gpuT = s.Value;
            }
            foreach (var s in h.Sensors.Where(s => s.SensorType is SensorType.Power or SensorType.Clock or SensorType.Load && s.Value.HasValue && (h.HardwareType == HardwareType.Cpu || h.HardwareType.ToString().StartsWith("Gpu"))))
                other.Add(new JsonObject { ["hw"] = h.Name, ["kind"] = h.HardwareType.ToString(), ["type"] = s.SensorType.ToString(), ["name"] = s.Name, ["value"] = Math.Round((double)s.Value!, 1) });

            var rpm = h.Sensors.Where(s => s.SensorType == SensorType.Fan).ToList();
            var used = new HashSet<ISensor>();
            foreach (var c in h.Sensors.Where(s => s.SensorType == SensorType.Control))
            {
                var id = c.Identifier.ToString();
                var fan = rpm.FirstOrDefault(f => f.Index == c.Index);
                if (fan != null) used.Add(fan);
                var name = fan?.Name ?? c.Name.Replace("Fan Control", "Fan");
                lock (_lock) _controls[id] = c;
                fans.Add(new JsonObject
                {
                    ["id"] = id, ["name"] = name, ["hw"] = h.Name,
                    ["rpm"] = fan?.Value is float r ? Math.Round(r) : null,
                    ["percent"] = c.Value is float v ? Math.Round(v) : null,
                    ["controllable"] = c.Control != null,
                    ["floor"] = Floor(name),
                    ["managed"] = _overridden.Contains(id),
                });
            }
            foreach (var f in rpm.Where(f => !used.Contains(f) && f.Value > 0))
                fans.Add(new JsonObject { ["id"] = f.Identifier.ToString(), ["name"] = f.Name, ["hw"] = h.Name, ["rpm"] = Math.Round((double)f.Value!), ["controllable"] = false, ["floor"] = 0, ["managed"] = false });
        }

        // Thermal emergency with 5 °C hysteresis.
        var hottest = Math.Max(cpuT ?? 0, gpuT ?? 0);
        if (!_emergency && hottest >= 90) { _emergency = true; _log("thermal", $"emergency at {hottest:0.0}°C — all managed fans to 100%"); }
        else if (_emergency && hottest < 85) { _emergency = false; _log("thermal", "emergency cleared"); }

        lock (_lock)
        {
            foreach (var (id, p) in _profiles)
            {
                if (!_controls.TryGetValue(id, out var ctrl) || ctrl.Control == null) continue;
                if (p.Mode == "auto") { if (_overridden.Remove(id)) ctrl.Control.SetDefault(); continue; }

                double target;
                if (p.Mode == "fixed") target = p.Percent;
                else
                {
                    double? src = p.Source switch { "gpu" => gpuT, "max" => (cpuT.HasValue || gpuT.HasValue) ? Math.Max(cpuT ?? 0, gpuT ?? 0) : null, _ => cpuT };
                    if (src is null || double.IsNaN(src.Value))
                    {
                        if ((DateTime.UtcNow - p.LastFresh).TotalSeconds > 10)
                        {
                            if (_overridden.Remove(id)) { ctrl.Control.SetDefault(); _log("fan", $"{id}: sensor stale — BIOS control"); }
                            continue;
                        }
                        src = p.LastTemp;
                    }
                    else p.LastFresh = DateTime.UtcNow;

                    double t = src.Value;
                    // Hysteresis: ignore small drops so the fan doesn't hunt.
                    if (!double.IsNaN(p.LastTemp) && t < p.LastTemp && p.LastTemp - t < p.Hysteresis) t = p.LastTemp;
                    else p.LastTemp = t;
                    target = Interp(p.Curve, t);
                }
                if (_emergency) target = 100;
                target = Math.Clamp(target, p.Floor, 100);
                if (p.Current < 0) p.Current = ctrl.Value ?? target;
                var delta = target - p.Current;
                p.Current += delta > 0 ? Math.Min(delta, _emergency ? 100 : p.StepUp) : Math.Max(delta, -p.StepDown);
                ctrl.Control.SetSoftware((float)Math.Round(p.Current));
                _overridden.Add(id);
            }
        }

        _last = new JsonObject
        {
            ["ts"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["cpuTemp"] = cpuT is double ct ? Math.Round(ct, 1) : null,
            ["gpuTemp"] = gpuT is double gt ? Math.Round(gt, 1) : null,
            ["temps"] = temps,
            ["fans"] = fans,
            ["sensors"] = other,
            ["emergency"] = _emergency,
            ["board"] = hw.FirstOrDefault(h => h.HardwareType == HardwareType.Motherboard)?.Name,
            ["error"] = _error,
            ["pawnio"] = PawnIoInstalled(),
        };
    }

    static bool PawnIoInstalled()
    {
        try { return System.ServiceProcess.ServiceController.GetDevices().Any(d => d.ServiceName.StartsWith("PawnIO", StringComparison.OrdinalIgnoreCase)); }
        catch { return false; }
    }

    static double Interp(List<(double t, double p)> c, double t)
    {
        if (c.Count == 0) return 100;
        var pts = c.OrderBy(x => x.t).ToList();
        if (t <= pts[0].t) return pts[0].p;
        if (t >= pts[^1].t) return pts[^1].p;
        for (int i = 1; i < pts.Count; i++)
            if (t <= pts[i].t)
            {
                var (t0, p0) = pts[i - 1]; var (t1, p1) = pts[i];
                return p0 + (p1 - p0) * (t - t0) / Math.Max(0.001, t1 - t0);
            }
        return pts[^1].p;
    }

    public JsonNode Snapshot() => JsonNode.Parse(_last.ToJsonString())!;

    public void Apply(JsonObject p)
    {
        lock (_lock)
        {
            foreach (var (id, node) in p["fans"]!.AsObject())
            {
                if (node is not JsonObject o) continue;
                var name = _controls.TryGetValue(id, out var c) ? c.Name : id;
                var pr = _profiles.TryGetValue(id, out var existing) ? existing : new Profile();
                pr.Mode = o["mode"]?.GetValue<string>() ?? "auto";
                if (pr.Mode is not ("auto" or "fixed" or "curve")) pr.Mode = "auto";
                pr.Percent = o["percent"]?.GetValue<double>() ?? pr.Percent;
                pr.Source = o["source"]?.GetValue<string>() ?? "cpu";
                pr.Hysteresis = Math.Clamp(o["hysteresis"]?.GetValue<double>() ?? 3, 0, 10);
                pr.StepUp = Math.Clamp(o["stepUp"]?.GetValue<double>() ?? 8, 1, 100);
                pr.StepDown = Math.Clamp(o["stepDown"]?.GetValue<double>() ?? 3, 1, 100);
                pr.Floor = Math.Max(Floor(name), Math.Clamp(o["minPercent"]?.GetValue<double>() ?? 0, 0, 100));
                if (o["curve"] is JsonArray arr && arr.Count >= 2)
                    pr.Curve = arr.Select(x => (x![0]!.GetValue<double>(), Math.Clamp(x[1]!.GetValue<double>(), 0, 100))).ToList();
                _profiles[id] = pr;
            }
        }
    }

    public void ReleaseAll()
    {
        lock (_lock)
        {
            foreach (var id in _overridden.ToList())
                if (_controls.TryGetValue(id, out var c)) { try { c.Control?.SetDefault(); } catch { } }
            _overridden.Clear();
            foreach (var p in _profiles.Values) { p.Mode = "auto"; p.Current = -1; }
        }
    }
}
