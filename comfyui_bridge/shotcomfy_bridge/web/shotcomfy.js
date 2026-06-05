import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Load a workflow pushed from ShotComfy into the currently open ComfyUI editor.
app.registerExtension({
  name: "ShotComfy.Bridge",
  async setup() {
    api.addEventListener("shotcomfy.load", async (event) => {
      try {
        const data = event.detail;
        if (!data) return;
        await app.loadGraphData(data);
      } catch (e) {
        console.error("[ShotComfy] failed to load workflow", e);
      }
    });
    console.log("[ShotComfy] bridge ready");
  },
});
