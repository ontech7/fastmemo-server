import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ConfigError, loadConfig } from "../src/config.ts";

const KEY = "0123456789abcdef0123";

describe("config", () => {
  test("refuses to start without an access key, and says which setting is missing", () => {
    for (const env of [{}, { FASTMEMO_ACCESS_KEY: "" }, { FASTMEMO_ACCESS_KEY: "   " }]) {
      assert.throws(
        () => loadConfig(env),
        (e: unknown) => e instanceof ConfigError && e.message.startsWith("FASTMEMO_ACCESS_KEY is not set")
      );
    }
  });

  test("refuses a short access key without echoing it", () => {
    assert.throws(
      () => loadConfig({ FASTMEMO_ACCESS_KEY: "short-key" }),
      (e: unknown) => e instanceof ConfigError && /at least 16/.test(e.message) && !e.message.includes("short-key")
    );
  });

  test("takes the access key, and leaves the admin key to it when unset", () => {
    const config = loadConfig({ FASTMEMO_ACCESS_KEY: ` ${KEY} ` });
    assert.equal(config.accessKey, KEY);
    assert.equal(config.adminKey, null);
  });

  test("the release check is on unless turned off, and says so when the value is neither", () => {
    const check = (value?: string) =>
      loadConfig({ FASTMEMO_ACCESS_KEY: KEY, ...(value === undefined ? {} : { UPDATE_CHECK: value }) }).updateCheck;
    assert.equal(check(), true);
    assert.equal(check(""), true);
    for (const value of ["off", "false", "0", "no", "OFF", "False", " No "]) assert.equal(check(value), false, value);
    for (const value of ["on", "true", "1", "yes", "ON", "True"]) assert.equal(check(value), true, value);
    assert.throws(
      () => check("maybe"),
      (e: unknown) => e instanceof ConfigError && e.message.startsWith("UPDATE_CHECK")
    );
  });

  test("the updater's folders are off unless set", () => {
    const unset = loadConfig({ FASTMEMO_ACCESS_KEY: KEY });
    assert.equal(unset.updateRequestDir, null);
    assert.equal(unset.updateStatusDir, null);
    const set = loadConfig({
      FASTMEMO_ACCESS_KEY: KEY,
      UPDATE_REQUEST_DIR: " /updates/request ",
      UPDATE_STATUS_DIR: "/updates/status",
    });
    assert.equal(set.updateRequestDir, "/updates/request");
    assert.equal(set.updateStatusDir, "/updates/status");
  });
});
