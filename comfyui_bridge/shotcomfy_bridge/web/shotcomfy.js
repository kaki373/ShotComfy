import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// Bridge between ShotComfy and the open ComfyUI editor.
app.registerExtension({
  name: "ShotComfy.Bridge",
  async setup() {
    // Load a workflow pushed from ShotComfy into the editor.
    api.addEventListener("shotcomfy.load", async (event) => {
      try {
        const data = event.detail;
        if (!data) return;
        await app.loadGraphData(data);
      } catch (e) {
        console.error("[ShotComfy] failed to load workflow", e);
      }
    });

    // Convert a UI-format workflow to API format using ComfyUI's own converter
    // (app.graphToPrompt). The current graph is saved and restored so the user's
    // working canvas is not disturbed.
    api.addEventListener("shotcomfy.convert", async (event) => {
      const { id, graph } = event.detail || {};
      let saved = null;
      try {
        saved = app.graph.serialize();
      } catch (e) {
        /* ignore */
      }
      const post = (body) =>
        api.fetchApi("/shotcomfy/api_result", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, ...body }),
        });
      try {
        await app.loadGraphData(graph);
        await new Promise((r) => setTimeout(r, 200)); // let widgets settle
        const p = await app.graphToPrompt();
        await post({ prompt: p.output });
      } catch (e) {
        console.error("[ShotComfy] convert failed", e);
        await post({ error: String(e) });
      } finally {
        if (saved) {
          try {
            await app.loadGraphData(saved);
          } catch (e) {
            /* ignore restore failure */
          }
        }
      }
    });

    console.log("[ShotComfy] bridge ready (load + convert)");
  },
});
