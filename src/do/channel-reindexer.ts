import { getContainer } from "@cloudflare/containers";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types.js";

const REINDEX_DEBOUNCE_MS = 5_000;
const CONTAINER_COLD_START_RETRY_MS = 30_000;

export class ChannelReindexer extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/notify" && request.method === "POST") {
      const { channel, subdir } = await request.json<{ channel: string; subdir: string }>();
      await this.ctx.storage.put("channel", channel);
      await this.ctx.storage.put("subdir", subdir);
      await this.ctx.storage.put("dirty", true);
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null) {
        await this.ctx.storage.setAlarm(Date.now() + REINDEX_DEBOUNCE_MS);
      }
      return new Response("noted", { status: 202 });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const dirty = await this.ctx.storage.get<boolean>("dirty");
    if (!dirty) return;
    const channel = await this.ctx.storage.get<string>("channel");
    const subdir = await this.ctx.storage.get<string>("subdir");
    if (!channel || !subdir) return;

    await this.ctx.storage.put("dirty", false);

    try {
      const container = getContainer(this.env.INDEXER, `${channel}/${subdir}/_cold-index`);
      const resp = await container.fetch("http://container/reindex", {
        method: "POST",
        body: JSON.stringify({ channel, subdir }),
        headers: { "content-type": "application/json" },
      });
      // 200 = synchronous success, 202 = cold reindex kicked off in the
      // container's background thread — both mean the task was accepted.
      if (!resp.ok) {
        await this.ctx.storage.put("dirty", true);
        const retryMs = resp.status === 500 ? CONTAINER_COLD_START_RETRY_MS : 60_000;
        await this.ctx.storage.setAlarm(Date.now() + retryMs);
        return;
      }
    } catch (err) {
      await this.ctx.storage.put("dirty", true);
      const msg = String(err);
      const isCapacity = msg.includes("no container instance") || msg.includes("try again later");
      const isColdStart =
        msg.includes("connection closed") || msg.includes("port") || msg.includes("Network");
      const retryMs = isCapacity ? 15_000 : isColdStart ? CONTAINER_COLD_START_RETRY_MS : 60_000;
      await this.ctx.storage.setAlarm(Date.now() + retryMs);
      return;
    }

    const stillDirty = await this.ctx.storage.get<boolean>("dirty");
    if (stillDirty) {
      await this.ctx.storage.setAlarm(Date.now() + REINDEX_DEBOUNCE_MS);
    }
  }
}