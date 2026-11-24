//! Network inspector (FR-05): connections and listeners with owning PID, adapters.
//! "Connection", "listening" and "bytes" are kept as distinct facts â€” this module
//! never claims per-connection bandwidth.

use crate::winutil::*;
use serde::Serialize;
use std::net::{Ipv4Addr, Ipv6Addr};
use windows::Win32::Foundation::*;
use windows::Win32::NetworkManagement::IpHelper::*;
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::Networking::WinSock::*;

#[derive(Serialize, Clone)]
pub struct Conn {
    pub proto: String,
    pub local: String,
    pub lport: u16,
    pub remote: String,
    pub rport: u16,
    pub state: String,
    pub pid: u32,
    pub scope: String,
}

fn state_name(s: u32) -> &'static str {
    match s {
        1 => "Closed", 2 => "Listening", 3 => "SynSent", 4 => "SynReceived", 5 => "Established",
        6 => "FinWait1", 7 => "FinWait2", 8 => "CloseWait", 9 => "Closing", 10 => "LastAck",
        11 => "TimeWait", 12 => "DeleteTcb", _ => "Unknown",
    }
}

fn scope_of(ip: &str) -> String {
    if ip == "0.0.0.0" || ip == "::" || ip == "*" { return "any".into(); }
    if ip.starts_with("127.") || ip == "::1" { return "loopback".into(); }
    if let Ok(v4) = ip.parse::<Ipv4Addr>() {
        if v4.is_private() || v4.is_link_local() { return "lan".into(); }
        return "external".into();
    }
    if let Ok(v6) = ip.parse::<Ipv6Addr>() {
        let s = v6.segments()[0];
        if (s & 0xfe00) == 0xfc00 || (s & 0xffc0) == 0xfe80 { return "lan".into(); }
        return "external".into();
    }
    "unknown".into()
}

fn port(p: u32) -> u16 {
    u16::from_be(p as u16)
}

unsafe fn table(af: u32, tcp: bool) -> Vec<u8> {
    let mut size = 0u32;
    for _ in 0..4 {
        let mut buf = vec![0u8; size.max(1) as usize];
        let r = if tcp {
            GetExtendedTcpTable(Some(buf.as_mut_ptr() as _), &mut size, false, af, TCP_TABLE_OWNER_PID_ALL, 0)
        } else {
            GetExtendedUdpTable(Some(buf.as_mut_ptr() as _), &mut size, false, af, UDP_TABLE_OWNER_PID, 0)
        };
        if r == NO_ERROR.0 { return buf; }
        if r != ERROR_INSUFFICIENT_BUFFER.0 { break; }
    }
    vec![]
}

pub fn connections() -> Vec<Conn> {
    let mut out = vec![];
    unsafe {
        let b = table(AF_INET.0 as u32, true);
        if b.len() >= 4 {
            let t = &*(b.as_ptr() as *const MIB_TCPTABLE_OWNER_PID);
            let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
            for r in rows {
                let l = Ipv4Addr::from(u32::from_be(r.dwLocalAddr)).to_string();
                let rem = Ipv4Addr::from(u32::from_be(r.dwRemoteAddr)).to_string();
                out.push(Conn { proto: "TCP".into(), scope: scope_of(&rem), local: l, lport: port(r.dwLocalPort), remote: rem, rport: port(r.dwRemotePort), state: state_name(r.dwState).into(), pid: r.dwOwningPid });
            }
        }
        let b = table(AF_INET6.0 as u32, true);
        if b.len() >= 4 {
            let t = &*(b.as_ptr() as *const MIB_TCP6TABLE_OWNER_PID);
            let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
            for r in rows {
                let l = Ipv6Addr::from(r.ucLocalAddr).to_string();
                let rem = Ipv6Addr::from(r.ucRemoteAddr).to_string();
                out.push(Conn { proto: "TCPv6".into(), scope: scope_of(&rem), local: l, lport: port(r.dwLocalPort), remote: rem, rport: port(r.dwRemotePort), state: state_name(r.dwState).into(), pid: r.dwOwningPid });
            }
        }
        let b = table(AF_INET.0 as u32, false);
        if b.len() >= 4 {
            let t = &*(b.as_ptr() as *const MIB_UDPTABLE_OWNER_PID);
            let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
            for r in rows {
                let l = Ipv4Addr::from(u32::from_be(r.dwLocalAddr)).to_string();
                out.push(Conn { proto: "UDP".into(), scope: scope_of(&l), local: l, lport: port(r.dwLocalPort), remote: "*".into(), rport: 0, state: "Bound".into(), pid: r.dwOwningPid });
            }
        }
        let b = table(AF_INET6.0 as u32, false);
        if b.len() >= 4 {
            let t = &*(b.as_ptr() as *const MIB_UDP6TABLE_OWNER_PID);
            let rows = std::slice::from_raw_parts(t.table.as_ptr(), t.dwNumEntries as usize);
            for r in rows {
                let l = Ipv6Addr::from(r.ucLocalAddr).to_string();
                out.push(Conn { proto: "UDPv6".into(), scope: scope_of(&l), local: l, lport: port(r.dwLocalPort), remote: "*".into(), rport: 0, state: "Bound".into(), pid: r.dwOwningPid });
            }
        }
    }
    out
}

#[derive(Serialize, Clone)]
pub struct Adapter {
    pub name: String,
    pub description: String,
    pub kind: String,
    pub up: bool,
    pub speed_mbps: u64,
    pub mac: String,
    pub ips: Vec<String>,
    pub gateways: Vec<String>,
    pub dns: Vec<String>,
    pub dhcp: bool,
    pub vpn_like: bool,
}

unsafe fn sockaddr(a: &SOCKET_ADDRESS) -> Option<String> {
    if a.lpSockaddr.is_null() { return None; }
    let fam = (*a.lpSockaddr).sa_family;
    if fam == AF_INET {
        let s = &*(a.lpSockaddr as *const SOCKADDR_IN);
        Some(Ipv4Addr::from(u32::from_be(s.sin_addr.S_un.S_addr)).to_string())
    } else if fam == AF_INET6 {
        let s = &*(a.lpSockaddr as *const SOCKADDR_IN6);
        Some(Ipv6Addr::from(s.sin6_addr.u.Byte).to_string())
    } else {
        None
    }
}

pub fn adapters() -> Vec<Adapter> {
    let mut out = vec![];
    unsafe {
        let mut size = 32_000u32;
        let mut buf = vec![0u8; size as usize];
        let flags = GAA_FLAG_INCLUDE_GATEWAYS | GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST;
        let mut r = GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(buf.as_mut_ptr() as _), &mut size);
        if r == ERROR_BUFFER_OVERFLOW.0 {
            buf = vec![0u8; size as usize];
            r = GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(buf.as_mut_ptr() as _), &mut size);
        }
        if r != NO_ERROR.0 { return out; }
        let mut p = buf.as_ptr() as *const IP_ADAPTER_ADDRESSES_LH;
        while !p.is_null() {
            let a = &*p;
            let kind = match a.IfType {
                6 => "Ethernet", 71 => "Wi-Fi", 24 => "Loopback", 23 | 53 | 131 => "Tunnel", 243 | 244 => "Cellular", _ => "Other",
            };
            let desc = pwstr(a.Description);
            let mut ips = vec![];
            let mut u = a.FirstUnicastAddress;
            while !u.is_null() { if let Some(s) = sockaddr(&(*u).Address) { ips.push(s); } u = (*u).Next; }
            let mut gws = vec![];
            let mut g = a.FirstGatewayAddress;
            while !g.is_null() { if let Some(s) = sockaddr(&(*g).Address) { gws.push(s); } g = (*g).Next; }
            let mut dns = vec![];
            let mut d = a.FirstDnsServerAddress;
            while !d.is_null() { if let Some(s) = sockaddr(&(*d).Address) { dns.push(s); } d = (*d).Next; }
            let mac = a.PhysicalAddress[..a.PhysicalAddressLength as usize].iter().map(|b| format!("{:02X}", b)).collect::<Vec<_>>().join("-");
            let low = desc.to_lowercase();
            out.push(Adapter {
                name: pwstr(a.FriendlyName),
                vpn_like: kind == "Tunnel" || ["vpn", "wireguard", "tap-", "tun", "openvpn", "nordlynx", "tailscale", "zerotier"].iter().any(|k| low.contains(k)),
                description: desc,
                kind: kind.into(),
                up: a.OperStatus == IfOperStatusUp,
                speed_mbps: a.TransmitLinkSpeed / 1_000_000,
                mac,
                ips,
                gateways: gws,
                dns,
                dhcp: a.Anonymous2.Flags & 0x4 != 0,
            });
            p = a.Next;
        }
    }
    out
}

/// Reachability probe (NETWORK-11): DNS resolve + TCP connect latency to a host the user chooses.
pub fn probe(host: &str, port: u16) -> serde_json::Value {
    use std::net::ToSocketAddrs;
    let t0 = std::time::Instant::now();
    let addrs: Vec<_> = match (host, port).to_socket_addrs() {
        Ok(a) => a.collect(),
        Err(e) => return serde_json::json!({ "ok": false, "stage": "dns", "error": e.to_string() }),
    };
    let dns_ms = t0.elapsed().as_millis();
    let Some(addr) = addrs.first() else { return serde_json::json!({ "ok": false, "stage": "dns", "error": "no address" }) };
    let t1 = std::time::Instant::now();
    match std::net::TcpStream::connect_timeout(addr, std::time::Duration::from_secs(3)) {
        Ok(_) => serde_json::json!({ "ok": true, "dns_ms": dns_ms, "connect_ms": t1.elapsed().as_millis(), "addr": addr.ip().to_string() }),
        Err(e) => serde_json::json!({ "ok": false, "stage": "connect", "dns_ms": dns_ms, "error": e.to_string() }),
    }
}
