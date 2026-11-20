// Tests for the area-flag re-read added by this fork, run against the bundle
// itself with a fake panel connection (no network).
//   node --test test/
// T2M_BUNDLE=<path> runs the same tests against another bundle (e.g. upstream).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";
import { afterEach, beforeEach, mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const bundlePath = process.env.T2M_BUNDLE
  ? path.resolve(process.env.T2M_BUNDLE)
  : fileURLToPath(new URL("../app/dist/texecom2mqtt.js", import.meta.url));

const loadBundle = () => {
  let src = readFileSync(bundlePath, "utf8");
  const main = src.indexOf("// src/index.ts\n(async () => {");
  assert.ok(main > 0, "entry point not found in bundle");
  src = `${src.slice(0, main)}\nmodule.exports = { Panel, TexecomConnectionError };\n`;
  const m = new Module(bundlePath);
  m.filename = bundlePath;
  m.paths = Module._nodeModulePaths(path.dirname(bundlePath));
  m._compile(src, bundlePath);
  return m.exports;
};

const { Panel, TexecomConnectionError } = loadBundle();

const DISARMED = 0;
const IN_EXIT = 1;
const ARMED = 3;
const PART_ARMED = 4;
const IN_ALARM = 5;

const flush = async () => {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const makeLog = () => {
  const lines = [];
  const at = (level) => (msg) => lines.push(`${level}: ${msg}`);
  return {
    lines,
    error: at("error"),
    warning: at("warning"),
    info: at("info"),
    panel: at("panel"),
    debug: at("debug"),
    trace: at("trace"),
  };
};

// Premier Elite 24: one byte per area flag, area A = bit 0.
const setup = ({ status, flags = [] }) => {
  const log = makeLog();
  const panel = new Panel(
    { texecom: { host: "127.0.0.1", port: 1 }, areas: [], zones: [], cache: false },
    log
  );
  const calls = [];
  // hang: the command is queued but never answered, as when the panel drops the
  // connection (the queue is then cleared without settling the promise)
  const fake = { flags, error: undefined, onRead: undefined, hang: false };
  const send = (name, result) => {
    calls.push(name);
    return fake.hang ? new Promise(() => {}) : Promise.resolve(result);
  };
  panel.texecom = {
    getAreaFlags: async (start, count, areaSize) => {
      calls.push("getAreaFlags");
      fake.onRead?.();
      if (fake.error) throw fake.error;
      const buf = Buffer.alloc(count * areaSize);
      for (const flag of fake.flags) {
        if (flag >= start && flag < start + count) buf[(flag - start) * areaSize] |= 1;
      }
      return buf;
    },
    reset: () => send("reset", true),
    disarm: () => send("disarm", true),
    arm: () => send("arm", true),
    setEventMessages: async () => true,
    getSystemPower: async () => false,
  };
  // reconnect path: login, power and the full re-read are not under test here
  panel.login = async () => true;
  panel.fetchSystemPower = async () => {};
  panel.refreshData = async () => {};
  panel.device = { zones: 24, model: "Premier Elite 24", serialNumber: "0", firmwareVersion: "0" };
  panel.areas = [panel.createAreaFromPanelArea({ id: "A", number: 1, panelName: "Maison" })];
  panel.areas[0].status = status;
  panel.initComplete = true;
  panel.hasPanelConfig = true;
  panel.loggedIn = true;
  panel.areaRefreshReady = true;
  const updates = [];
  panel.on("area_update", (area) => updates.push(area.status));
  return { panel, area: panel.areas[0], log, calls, fake, updates };
};

const reads = (calls) => calls.filter((c) => c === "getAreaFlags").length;

beforeEach(() => mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 1_795_000_000_000 }));
afterEach(() => mock.timers.reset());

test("remote disarm while shown in alarm re-reads the flags and publishes Disarmed", async () => {
  const { panel, area, calls, updates, log } = setup({ status: IN_ALARM, flags: [] });
  await panel.disarm(area);
  assert.deepEqual(calls, ["reset", "disarm"]);
  mock.timers.tick(2999);
  await flush();
  assert.equal(reads(calls), 0);
  mock.timers.tick(1);
  await flush();
  assert.equal(reads(calls), 1);
  assert.equal(area.status, DISARMED);
  assert.deepEqual(updates, [DISARMED]);
  assert.ok(log.lines.includes("info: Maison status changed to Disarmed (re-read after remote disarm)"));
});

test("alarm flag still set: stays in alarm and logs the active flags once", async () => {
  const { panel, area, calls, updates, log } = setup({ status: IN_ALARM, flags: [0, 27] });
  await panel.disarm(area);
  mock.timers.tick(3000);
  await flush();
  mock.timers.tick(60000);
  await flush();
  assert.equal(reads(calls), 2);
  assert.equal(area.status, IN_ALARM);
  assert.deepEqual(updates, []);
  const flagLines = log.lines.filter((l) => l.includes("alarm flag is set"));
  assert.deepEqual(flagLines, ["info: Area A alarm flag is set, active area flags: 0,27"]);
});

test("periodic check corrects a latched alarm once the flag clears", async () => {
  const { area, calls, fake, updates } = setup({ status: IN_ALARM, flags: [0] });
  mock.timers.tick(60000);
  await flush();
  assert.equal(reads(calls), 1);
  assert.equal(area.status, IN_ALARM);
  fake.flags = [];
  mock.timers.tick(60000);
  await flush();
  assert.equal(area.status, DISARMED);
  assert.deepEqual(updates, [DISARMED]);
});

test("Reset After Alarm log event triggers a re-read", async () => {
  const { panel, area, calls, updates } = setup({ status: IN_ALARM, flags: [] });
  await panel.handleLogEvent({ type: 45, areas: 1, parameter: 0, groupType: 0 });
  mock.timers.tick(3000);
  await flush();
  assert.equal(reads(calls), 1);
  assert.equal(area.status, DISARMED);
  assert.deepEqual(updates, [DISARMED]);
});

test("armed flags map to the part-arm mode", async () => {
  const { area, updates } = setup({ status: IN_ALARM, flags: [21, 23, 50] });
  mock.timers.tick(60000);
  await flush();
  assert.equal(area.status, PART_ARMED);
  assert.equal(area.partArm, 1);
  assert.deepEqual(updates, [PART_ARMED]);
});

test("areas not in alarm are never re-read or overwritten", async () => {
  const { panel, area, calls, updates } = setup({ status: IN_EXIT, flags: [] });
  await panel.disarm(area);
  mock.timers.tick(3000);
  await flush();
  mock.timers.tick(60000);
  await flush();
  assert.equal(reads(calls), 0);
  assert.equal(area.status, IN_EXIT);
  assert.deepEqual(updates, []);
});

test("an area event received during the re-read wins", async () => {
  const { panel, area, fake, updates } = setup({ status: IN_ALARM, flags: [] });
  fake.onRead = () => {
    area.status = ARMED;
  };
  await panel.refreshAlarmedAreas("test");
  assert.equal(area.status, ARMED);
  assert.deepEqual(updates, []);
});

test("a new alarm received during the re-read is not overwritten", async () => {
  const { panel, area, fake, updates } = setup({ status: IN_ALARM, flags: [] });
  fake.onRead = () => {
    panel.handleAreaEvent({ areaNumber: 1, areaState: DISARMED });
    panel.handleAreaEvent({ areaNumber: 1, areaState: IN_ALARM });
  };
  await panel.refreshAlarmedAreas("test");
  assert.equal(area.status, IN_ALARM);
  assert.deepEqual(updates, [DISARMED, IN_ALARM]);
});

test("no re-read between a disconnect and the end of the reconnect", async () => {
  const { panel, calls } = setup({ status: IN_ALARM, flags: [] });
  await panel.handlePanelStatus("disconnected");
  mock.timers.tick(60000);
  await flush();
  await panel.refreshAlarmedAreas("test");
  assert.equal(reads(calls), 0);
});

test("connection errors are rethrown so the global handler reconnects", async () => {
  const { panel, fake } = setup({ status: IN_ALARM });
  fake.error = new TexecomConnectionError("Command GetAreaFlags timed out");
  await assert.rejects(panel.refreshAlarmedAreas("test"), TexecomConnectionError);
});

test("other errors are logged and swallowed", async () => {
  const { panel, area, fake, log } = setup({ status: IN_ALARM });
  fake.error = new Error("boom");
  await panel.refreshAlarmedAreas("test");
  assert.equal(area.status, IN_ALARM);
  assert.ok(log.lines.includes("warning: Could not re-read area flags: boom"));
});

test("a disconnect cancels a pending re-read", async () => {
  const { panel, area, calls } = setup({ status: IN_ALARM, flags: [] });
  await panel.disarm(area);
  await panel.handlePanelStatus("disconnected");
  mock.timers.tick(3000);
  await flush();
  assert.equal(reads(calls), 0);
  assert.equal(area.status, IN_ALARM);
});

test("full re-read on reconnect keeps the upstream mapping", async () => {
  const { panel, area } = setup({ status: DISARMED, flags: [0] });
  await panel.updateAreaStates();
  assert.equal(area.status, IN_ALARM);
  const armed = setup({ status: DISARMED, flags: [21, 22] });
  await armed.panel.updateAreaStates();
  assert.equal(armed.area.status, ARMED);
  assert.equal(armed.area.partArm, undefined);
});

// The panel drops the connection for ~30-45 s on every alarm (SmartCom
// reporting). A remote disarm sent in that window is lost: the command queue is
// cleared on disconnect. It is sent again once the panel is back.
const cmds = (calls) => calls.filter((c) => c !== "getAreaFlags");
const reconnect = async (panel) => {
  await panel.handlePanelStatus("disconnected");
  await panel.handlePanelStatus("connected");
  await flush();
};

test("a remote disarm lost with the panel connection is sent again once the panel is back", async () => {
  const { panel, area, calls, fake, log } = setup({ status: IN_ALARM, flags: [0] });
  fake.hang = true;
  panel.disarm(area);
  await flush();
  assert.deepEqual(cmds(calls), ["reset"]);
  fake.hang = false;
  mock.timers.tick(25000);
  await reconnect(panel);
  assert.deepEqual(cmds(calls), ["reset", "reset", "disarm"]);
  assert.ok(log.lines.includes("info: Retrying the remote disarm of Maison requested 25s ago (the panel connection was lost)"));
});

test("a lost remote disarm is retried at every reconnect until it gets through", async () => {
  const { panel, area, calls, fake } = setup({ status: IN_ALARM, flags: [0] });
  fake.hang = true;
  panel.disarm(area);
  await reconnect(panel);
  assert.deepEqual(cmds(calls), ["reset", "reset"]);
  fake.hang = false;
  await reconnect(panel);
  assert.deepEqual(cmds(calls), ["reset", "reset", "reset", "disarm"]);
  await reconnect(panel);
  assert.deepEqual(cmds(calls), ["reset", "reset", "reset", "disarm"]);
});

test("a lost remote disarm older than 2 minutes is dropped", async () => {
  const { panel, area, calls, fake, log } = setup({ status: IN_ALARM, flags: [0] });
  fake.hang = true;
  panel.disarm(area);
  await flush();
  fake.hang = false;
  mock.timers.tick(120001);
  await reconnect(panel);
  assert.deepEqual(cmds(calls), ["reset"]);
  assert.ok(log.lines.includes("warning: Not retrying the remote disarm of Maison: requested 120s ago"));
});

test("a lost remote disarm is not retried when the area is no longer in alarm", async () => {
  const { panel, area, calls, fake } = setup({ status: IN_ALARM, flags: [] });
  fake.hang = true;
  panel.disarm(area);
  await flush();
  fake.hang = false;
  await panel.handlePanelStatus("disconnected");
  area.status = ARMED;
  await panel.handlePanelStatus("connected");
  await flush();
  assert.deepEqual(cmds(calls), ["reset"]);
});

test("an arm request cancels the retry of a lost disarm", async () => {
  const { panel, area, calls, fake } = setup({ status: IN_ALARM, flags: [0] });
  fake.hang = true;
  panel.disarm(area);
  panel.arm(area, 1);
  await flush();
  fake.hang = false;
  await reconnect(panel);
  assert.deepEqual(cmds(calls), ["reset", "arm"]);
});

test("a remote disarm that got through is not sent again", async () => {
  const { panel, area, calls } = setup({ status: IN_ALARM, flags: [0] });
  await panel.disarm(area);
  await reconnect(panel);
  assert.deepEqual(cmds(calls), ["reset", "disarm"]);
});
