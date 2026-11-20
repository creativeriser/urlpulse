'use strict';

const net = require('node:net');
const dns = require('node:dns').promises;

/** Strip the brackets WHATWG URL keeps around IPv6 literals. */
const unbracket = (host) => (host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

const V4_BLOCKS = [
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // RFC1918
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incl. cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // RFC1918
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.168.0.0', 16], // RFC1918
  ['198.18.0.0', 15], // benchmarking
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved + broadcast
].map(([base, bits]) => ({ start: ipv4ToInt(base), size: 2 ** (32 - bits) }));

function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);
  return V4_BLOCKS.some(({ start, size }) => value >= start && value < start + size);
}

/** Expand an IPv6 literal into eight 16-bit groups (handles "::" and a trailing dotted quad). */
function ipv6Groups(ip) {
  let text = ip.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = ipv4ToInt(dotted[1]);
    text = `${text.slice(0, -dotted[1].length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = text.split('::');
  const first = head ? head.split(':') : [];
  const last = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - first.length - last.length;
  return [...first, ...Array(Math.max(fill, 0)).fill('0'), ...last].map((group) => Number.parseInt(group, 16));
}

const v4FromGroups = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1)
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  if (/^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/.test(lower)) return true; // hex-form mapped: be conservative
  const first = Number.parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast

  // Transition mechanisms that carry an IPv4 address: judge the embedded address.
  const g = ipv6Groups(lower);
  if (g.length !== 8 || g.some(Number.isNaN)) return true; // unparseable: fail closed
  if (g.slice(0, 6).every((group) => group === 0)) return true; // ::/96 IPv4-compatible (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b) {
    if (g[2] === 1) return true; // 64:ff9b:1::/48 local-use NAT64 (RFC 8215)
    if (g.slice(2, 6).every((group) => group === 0)) return isPrivateIPv4(v4FromGroups(g[6], g[7])); // 64:ff9b::/96 NAT64
  }
  if (g[0] === 0x2002) return isPrivateIPv4(v4FromGroups(g[1], g[2])); // 2002::/16 6to4
  return false;
}

function isPrivateIp(ip) {
  const clean = unbracket(ip);
  const family = net.isIP(clean);
  if (family === 4) return isPrivateIPv4(clean);
  if (family === 6) return isPrivateIPv6(clean);
  return false;
}

const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.intranet', '.lan', '.home.arpa'];

/**
 * Synchronous, DNS-free check used when a link is created: rejects obvious
 * internal targets (localhost, *.internal, private/loopback IP literals).
 */
function isBlockedHostname(hostname) {
  const host = unbracket(hostname).toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (net.isIP(host)) return isPrivateIp(host);
  return false;
}

/**
 * Resolve a hostname and make sure EVERY address it points to is public.
 * Used by the uptime monitor before it connects (SSRF guard).
 * Note: there is an inherent resolve-then-connect gap (DNS rebinding); see
 * DOCUMENTATION.md > Security > Known limitations.
 */
async function assertPublicHost(hostname, lookup = dns.lookup) {
  const host = unbracket(hostname);
  if (isBlockedHostname(host)) throw new Error('target host is not allowed');
  if (net.isIP(host)) return;
  const addresses = await lookup(host, { all: true });
  if (!addresses.length) throw new Error('target host did not resolve');
  if (addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('target resolves to a private address');
  }
}

module.exports = { isPrivateIp, isBlockedHostname, assertPublicHost };
