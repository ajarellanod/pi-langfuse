import test from "node:test";
import assert from "node:assert/strict";

import { shapePayload } from "../src/utils.ts";

test("shapePayload aborts when node budget is exceeded", () => {
  const payload = {
    keep: { value: 1 },
    blowUp: {
      nested: {
        value: 2,
      },
    },
  };

  const shaped = shapePayload(payload, { maxNodes: 3 });

  assert.deepEqual(shaped, {
    keep: {
      value: 1,
    },
    blowUp: "[payload too large]",
  });
});

test("shapePayload stops iterating wide objects after the configured key limit", () => {
  let accessed = 0;
  const payload = Object.create(null) as Record<string, number>;

  for (let index = 0; index < 200; index++) {
    Object.defineProperty(payload, `key${index}`, {
      enumerable: true,
      get() {
        accessed++;
        return index;
      },
    });
  }

  const shaped = shapePayload(payload) as Record<string, number>;

  assert.equal(Object.keys(shaped).length, 80);
  assert.equal(accessed, 80);
});

test("shapePayload preserves circular protection for normal payloads", () => {
  const payload: Record<string, unknown> = { name: "root" };
  payload.self = payload;

  const shaped = shapePayload(payload);

  assert.deepEqual(shaped, {
    name: "root",
    self: "[circular]",
  });
});
