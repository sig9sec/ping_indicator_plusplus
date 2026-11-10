import test from "node:test";
import assert from "node:assert/strict";

import { classifyStderr, stdoutUnreachable } from "../failureClassifier.js";

test("stderr classification (fixtures captured from iputils 20250605)", () => {
  assert.equal(classifyStderr("ping: connect: Network is unreachable"), "No network");
  assert.equal(
    classifyStderr("ping: example.invalid: Name or service not known"),
    "DNS Err",
  );
  assert.equal(
    classifyStderr("ping: 2001:db8::1: Address family for hostname not supported"),
    "Bad dest",
  );
  assert.equal(classifyStderr(""), "Error");
  assert.equal(classifyStderr("something unexpected"), "Error");
});

test("classification is case-insensitive across iputils versions", () => {
  assert.equal(classifyStderr("ping: foo: name or service not known"), "DNS Err");
  assert.equal(classifyStderr("ping: connect: network is unreachable"), "No network");
});

test("further stderr variants", () => {
  assert.equal(classifyStderr("ping: connect: No route to host"), "No network");
  assert.equal(
    classifyStderr("ping: sendmsg: Destination Host Unreachable"),
    "Unreachable",
  );
  assert.equal(classifyStderr("ping: foo: Name does not resolve"), "DNS Err");
});

test("stdout From-lines flag unreachability while ping keeps running", () => {
  assert.ok(
    stdoutUnreachable(
      "From 192.168.1.1 icmp_seq=1 Destination Host Unreachable",
    ),
  );
  assert.ok(
    !stdoutUnreachable("64 bytes from 8.8.8.8: icmp_seq=1 ttl=118 time=23.4 ms"),
  );
  assert.ok(!stdoutUnreachable("PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data."));
});
