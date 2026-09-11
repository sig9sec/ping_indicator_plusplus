// Pure failure classification for the ping subprocess: maps stderr
// text and stdout diagnostic lines to short failure reasons. No GNOME
// imports, so the module stays unit-testable with plain node.

// Ordered: first match wins. Matched case-insensitively because the
// exact wording differs across iputils versions (20250605 prints
// "Name or service not known", older releases lowercase it).
const STDERR_RULES = [
  ["Bad dest", /address family for hostname not supported/i],
  [
    "DNS Err",
    /name or service not known|unknown host|name resolution|does not resolve/i,
  ],
  ["No network", /network is unreachable|no route to host/i],
  ["Unreachable", /host unreachable|destination .*unreachable/i],
];

export function classifyStderr(text) {
  for (const [reason, pattern] of STDERR_RULES) {
    if (pattern.test(text)) return reason;
  }
  return "Error";
}

// iputils reports router-generated errors as
// "From 192.168.1.1 icmp_seq=1 Destination Host Unreachable" lines on
// stdout while the process keeps running.
export function stdoutUnreachable(text) {
  return /^from\b.*unreachable/i.test(text);
}
