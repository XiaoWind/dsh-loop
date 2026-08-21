import { test } from "node:test";
import assert from "node:assert/strict";
import { humanizeDuration, parseDurationMs } from "../lib/duration.js";

test("parseDurationMs: simple units", () => {
  assert.equal(parseDurationMs("30m"), 30 * 60_000);
  assert.equal(parseDurationMs("2h"), 2 * 3_600_000);
  assert.equal(parseDurationMs("90s"), 90_000);
  assert.equal(parseDurationMs("500ms"), 500);
  assert.equal(parseDurationMs("1d"), 86_400_000);
});

test("parseDurationMs: case-insensitive and combined", () => {
  assert.equal(parseDurationMs("30M"), 30 * 60_000);
  assert.equal(parseDurationMs("1h30m"), 3_600_000 + 1_800_000);
  assert.equal(parseDurationMs("1h30m45s"), 3_600_000 + 1_800_000 + 45_000);
  assert.equal(parseDurationMs("2d6h"), 2 * 86_400_000 + 6 * 3_600_000);
});

test("parseDurationMs: decimal", () => {
  assert.equal(parseDurationMs("1.5h"), 5_400_000);
  assert.equal(parseDurationMs("0.5s"), 500);
});

test("parseDurationMs: invalid inputs", () => {
  assert.equal(parseDurationMs(""), undefined);
  assert.equal(parseDurationMs("30"), undefined); // no unit
  assert.equal(parseDurationMs("m"), undefined);
  assert.equal(parseDurationMs("abc"), undefined);
  assert.equal(parseDurationMs("30 xm"), undefined);
  assert.equal(parseDurationMs("30m extra"), undefined); // trailing text
  assert.equal(parseDurationMs("-30m"), undefined);
  assert.equal(parseDurationMs("0m"), undefined); // zero
  assert.equal(parseDurationMs(123), undefined); // non-string
});

test("humanizeDuration: round trips common values", () => {
  assert.equal(humanizeDuration(45_000), "45s");
  assert.equal(humanizeDuration(30 * 60_000), "30m");
  assert.equal(humanizeDuration(90 * 60_000), "1h30m");
  assert.equal(humanizeDuration(2 * 86_400_000), "2d");
  assert.equal(humanizeDuration(500), "500ms");
  assert.equal(humanizeDuration(0), "0ms");
});

test("parseDurationMs then humanizeDuration round trips", () => {
  for (const input of ["30m", "1h30m", "2d", "45m"]) {
    const ms = parseDurationMs(input);
    assert.equal(humanizeDuration(ms), input);
  }
  // 90s normalizes to the more readable 1m30s.
  assert.equal(humanizeDuration(parseDurationMs("90s")), "1m30s");
});
