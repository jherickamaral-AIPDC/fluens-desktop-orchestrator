// Public asset identity only; not the private installation acceptance.
const pins = {
  "index.html": {
    "bytes": 4274,
    "sha256": "09df5c322fbbeb92163ff8d47d64b4df174a87f4402f7d51c7586765b8122ea4"
  },
  "motor.js": {
    "bytes": 15468,
    "sha256": "68bf7d6ab128c8d2ba2afb98436f5f521c9e8d4510c1bcd5469719a305dbf587"
  },
  "css/app.css": {
    "bytes": 22929,
    "sha256": "4f54523e42fb6182a5443427c95ef8ce9198751364f19d332cc80f451040517e"
  },
  "js/app.js": {
    "bytes": 119406,
    "sha256": "e91c23ce66d47e2671af0e4680ae91c500c2e6475bce6d613727431a761de1e5"
  },
  "js/db.js": {
    "bytes": 48785,
    "sha256": "be1c34a70b2a2cd87bd6cb45f19ac34698363395c27ed79931055d66152e0d8c"
  },
  "js/md.js": {
    "bytes": 5796,
    "sha256": "1158baca8f0f5bae891c791236a344d3231741edce21b0b10b8a3ffdc2de3bd9"
  }
};
for (const pin of Object.values(pins)) Object.freeze(pin);
export const PREPUBLICATION_UI_PINS = Object.freeze(pins);
export const POSTPUBLICATION_UI_PINS = PREPUBLICATION_UI_PINS;
export const FROZEN_UI_PINS = PREPUBLICATION_UI_PINS;
