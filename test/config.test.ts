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
});
