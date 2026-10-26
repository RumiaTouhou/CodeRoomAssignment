import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatServer } from "../server/app.js";
import { ChatController } from "../client/src/app/controller.js";
import { HttpClient } from "../client/src/services/http.js";
import { BrowserStorage, type StoragePort } from "../client/src/services/storage.js";
import type { CreateSessionRequest } from "../shared/http.js";

class MemoryStorage implements StoragePort {
  private readonly values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null; }
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
}

async function joined(controller: ChatController): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (controller.getSnapshot().screen !== "chat") {
    if (Date.now() > deadline) throw new Error("The guest could not join");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test("saved identity is the default return choice and opting out creates a distinct guest without restoring administrator authority", async () => {
  const password = "administrator-control";
  const server = createChatServer({ staticDir: false, adminPassword: password });
  const address = await server.listen();
  const localStorage = new MemoryStorage();
  const client = new HttpClient(address.origin);
  const requests: CreateSessionRequest[] = [];
  const controllers: ChatController[] = [];
  const create = () => {
    const storage = new BrowserStorage(address.origin, { localStorage, sessionStorage: new MemoryStorage() });
    const controller = new ChatController({
      apiOrigin: address.origin, storage,
      http: { createSession: (input, signal) => { requests.push(input); return client.createSession(input, signal); },
        revokeSession: (credential, signal) => client.revokeSession(credential, signal), search: (credential, input, signal) => client.search(credential, input, signal) },
      transportFactory: () => ({ connect: () => {}, disconnect: () => {}, send: () => false }),
      sound: { view: () => ({ mode: "off", playback: "not-enabled" }), restore: () => {}, setMode: async () => {}, preview: async () => {}, receive: () => {}, dispose: () => {} },
      navigation: { bindings: { viewportRef: () => {}, rowRef: () => () => {}, onScroll: () => {} },
        state: () => ({ atBottom: true, unseenIncomingCount: 0, navigationMode: "following", canReturnToReadingPosition: false, highlightedMessageId: null }),
        beforeUpdate: () => {}, afterUpdate: () => {}, jumpToMessage: () => true, jumpToLatest: () => {}, restoreReadingPosition: () => true, dispose: () => {} },
    });
    controllers.push(controller); controller.start(); return { controller, storage };
  };
  try {
    const initial = create();
    initial.controller.onJoinDisplayNameChange("Ada"); initial.controller.onJoinAdminPasswordChange(password); initial.controller.onJoinSubmit();
    await joined(initial.controller);
    const administrator = initial.controller.getSnapshot(); assert.equal(administrator.screen, "chat"); if (administrator.screen !== "chat") return;
    const identityId = administrator.chat.self.id;
    const identityToken = initial.storage.readRestoreCredential(); assert.ok(identityToken);
    assert.equal(administrator.chat.role, "admin"); assert.equal(requests[0]?.identityToken, undefined);
    initial.controller.stop();

    const returning = create();
    const choice = returning.controller.getSnapshot(); assert.equal(choice.screen, "join"); if (choice.screen !== "join") return;
    assert.equal(choice.join.restoreAvailable, true); assert.equal(choice.join.useSavedIdentity, true);
    returning.controller.onJoinDisplayNameChange("Ada returned"); returning.controller.onJoinSubmit(); await joined(returning.controller);
    const guest = returning.controller.getSnapshot(); assert.equal(guest.screen, "chat"); if (guest.screen !== "chat") return;
    assert.equal(guest.chat.self.id, identityId); assert.equal(guest.chat.role, "guest");
    assert.equal(requests[1]?.identityToken, identityToken); assert.equal(requests[1]?.adminPassword, undefined);
    returning.controller.stop();

    const distinct = create();
    distinct.controller.onJoinUseSavedIdentityChange(false); distinct.controller.onJoinDisplayNameChange("Grace");
    distinct.controller.onJoinAdminPasswordChange(password); distinct.controller.onJoinSubmit(); await joined(distinct.controller);
    const fresh = distinct.controller.getSnapshot(); assert.equal(fresh.screen, "chat"); if (fresh.screen !== "chat") return;
    assert.notEqual(fresh.chat.self.id, identityId); assert.equal(fresh.chat.role, "admin");
    assert.equal(requests[2]?.identityToken, undefined); assert.equal(requests[2]?.adminPassword, password);
    assert.notEqual(distinct.storage.readRestoreCredential(), identityToken);
  } finally {
    for (const controller of controllers) controller.stop();
    await server.close();
  }
});
