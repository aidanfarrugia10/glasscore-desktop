// ASUS Aura SDK adapter (RGB-05). Uses the SDK COM server ("aura.sdk.1") that
// Armoury Crate's LightingService registers — the official, vendor-signed path.

using System.Text.Json.Nodes;

namespace GlassCore.Broker;

public sealed class Aura
{
    readonly Action<string, string> _log;
    dynamic? _sdk;
    List<dynamic> _devs = new();
    bool _control;

    public Aura(Action<string, string> log) { _log = log; }

    bool Ensure()
    {
        if (_sdk != null) return true;
        try
        {
            var t = Type.GetTypeFromProgID("aura.sdk.1");
            if (t == null) return false;
            _sdk = Activator.CreateInstance(t);
            _sdk!.SwitchMode();
            _control = true;
            _devs.Clear();
            var col = _sdk.Enumerate(0);
            foreach (var d in col) _devs.Add(d);
            _log("aura", $"SDK attached, {_devs.Count} device(s)");
            return true;
        }
        catch (Exception ex)
        {
            _log("aura", "SDK unavailable: " + ex.Message);
            _sdk = null;
            return false;
        }
    }

    public JsonNode Devices()
    {
        var arr = new JsonArray();
        if (!Ensure()) return new JsonObject { ["available"] = false, ["devices"] = arr };
        for (int i = 0; i < _devs.Count; i++)
        {
            var d = _devs[i];
            int n = 0; string name = "Aura device"; uint type = 0;
            try { n = (int)d.Lights.Count; name = (string)d.Name; type = (uint)d.Type; } catch { }
            arr.Add(new JsonObject { ["index"] = i, ["name"] = name, ["type"] = type, ["lights"] = n });
        }
        return new JsonObject { ["available"] = true, ["devices"] = arr };
    }

    /// colors are 0x00RRGGBB; the SDK wants 0x00BBGGRR.
    public void Set(int device, uint[] colors)
    {
        if (!Ensure()) throw new InvalidOperationException("ASUS Aura SDK isn't available");
        if (device < 0 || device >= _devs.Count) throw new ArgumentOutOfRangeException(nameof(device));
        var d = _devs[device];
        int n = Math.Min((int)d.Lights.Count, colors.Length);
        for (int i = 0; i < n; i++)
        {
            uint c = colors[i];
            uint r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
            d.Lights[i].Color = (b << 16) | (g << 8) | r;
        }
        d.Apply();
    }

    public void Release()
    {
        try { if (_control) _sdk?.ReleaseControl(0); } catch { }
        _control = false;
        _sdk = null;
        _devs.Clear();
    }
}
