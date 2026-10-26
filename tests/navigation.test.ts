import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { TimelineController } from "../client/src/app/navigation.js";
import { messageRenderKey } from "../shared/ui.js";
import type { ChatMessage } from "../shared/domain.js";

function setup() {
  const dom = new JSDOM('<div id="viewport"></div>');
  const viewport = dom.window.document.getElementById("viewport") as HTMLDivElement;
  let messages: ChatMessage[] = [];
  let calls = 0;
  const controller = new TimelineController(() => calls++);
  Object.defineProperty(viewport, "clientHeight", { value: 200 });
  Object.defineProperty(viewport, "scrollHeight", { get: () => messages.length * 50 });
  viewport.getBoundingClientRect = () => ({ top: 0, bottom: 200, height: 200 } as DOMRect);
  controller.bindings.viewportRef(viewport);
  const user = { id: "alice", displayName: "Alice", avatarSeed: "alice" };
  const message = (n: number): ChatMessage => ({ id: `message-${n}`, roomId: "lobby", epochId: "epoch", clientOperationId: `operation-${n}`, author: user, sequence: n, createdAt: n, content: { kind: "text", text: `${n}` }, reply: null, reactions: [], mutationRevision: n });
  const populate = (values: number[], incoming: string[] = []) => {
    controller.beforeUpdate();
    messages = values.map(message);
    viewport.replaceChildren();
    messages.forEach((value, index) => {
      const row = dom.window.document.createElement("div"); viewport.append(row);
      row.getBoundingClientRect = () => ({ top: index * 50 - viewport.scrollTop, bottom: (index + 1) * 50 - viewport.scrollTop, height: 50 } as DOMRect);
      controller.bindings.rowRef(messageRenderKey(value))(row);
    });
    controller.afterUpdate({ epochId: "epoch", messages, newIncomingIds: incoming });
  };
  return { dom, viewport, controller, populate, calls: () => calls };
}

test("following tracks latest while reading preserves the visible anchor and counts arrivals", () => {
  const x = setup();
  try {
    x.populate([1,2,3,4,5,6,7,8]); assert.equal(x.viewport.scrollTop, 200);
    x.viewport.scrollTop = 50; x.controller.bindings.onScroll();
    x.populate([1,2,3,4,5,6,7,8,9], ["message-9"]);
    assert.equal(x.viewport.scrollTop, 50); assert.equal(x.controller.state().unseenIncomingCount, 1);
    x.controller.jumpToLatest(); assert.equal(x.viewport.scrollTop, 250); assert.equal(x.controller.state().unseenIncomingCount, 0);
  } finally { x.controller.dispose(); x.dom.window.close(); }
});

test("search can return to the original reading anchor after live arrivals", () => {
  const x = setup();
  try {
    x.populate([1,2,3,4,5,6,7,8,9,10]); x.viewport.scrollTop = 200; x.controller.bindings.onScroll();
    assert.equal(x.controller.jumpToMessage("message-2", "search"), true);
    x.populate([1,2,3,4,5,6,7,8,9,10,11], ["message-11"]);
    assert.equal(x.controller.state().navigationMode, "search");
    assert.equal(x.controller.restoreReadingPosition(), true); assert.equal(x.viewport.scrollTop, 200);
  } finally { x.controller.dispose(); x.dom.window.close(); }
});

test("pruned targets return false and stable projections do not trigger notification loops", () => {
  const x = setup();
  try {
    x.populate([1,2,3,4,5,6,7,8]); x.viewport.scrollTop = 50; x.controller.bindings.onScroll();
    x.controller.jumpToMessage("message-7", "quote"); x.populate([5,6,7,8,9,10]);
    assert.equal(x.controller.restoreReadingPosition(), false); assert.equal(x.controller.jumpToMessage("message-1", "quote"), false);
    const before = x.calls(); x.populate([5,6,7,8,9,10]); assert.equal(x.calls(), before);
    assert.equal(x.controller.bindings.rowRef("same"), x.controller.bindings.rowRef("same"));
  } finally { x.controller.dispose(); x.dom.window.close(); }
});

test("opening and canceling search restores the original anchor without a result selection", () => {
  const x = setup();
  try {
    x.populate([1,2,3,4,5,6,7,8]); x.viewport.scrollTop = 50; x.controller.bindings.onScroll();
    x.controller.beginSearch(); x.populate([1,2,3,4,5,6,7,8,9], ["message-9"]);
    assert.equal(x.controller.state().navigationMode, "search"); assert.equal(x.controller.cancelSearch(), true);
    assert.equal(x.viewport.scrollTop, 50); assert.equal(x.controller.state().navigationMode, "reading");
  } finally { x.controller.dispose(); x.dom.window.close(); }
});

test("background arrivals remain unseen until the following window regains attention", () => {
  let foreground = false;
  const controller = new TimelineController(() => {}, { attention: () => foreground });
  const dom = new JSDOM('<div></div>'); const viewport = dom.window.document.querySelector('div')!;
  Object.defineProperty(viewport, "clientHeight", { value: 200 }); Object.defineProperty(viewport, "scrollHeight", { value: 100 });
  controller.bindings.viewportRef(viewport);
  const message = { id: 'id', clientOperationId: 'op', author: { id: 'user' }, sequence: 1 } as ChatMessage;
  try {
    controller.afterUpdate({ epochId: 'epoch', messages: [message], newIncomingIds: ['id'] });
    assert.equal(controller.state().unseenIncomingCount, 1);
    foreground = true; controller.refreshAttention(); assert.equal(controller.state().unseenIncomingCount, 0);
  } finally { controller.dispose(); dom.window.close(); }
});
