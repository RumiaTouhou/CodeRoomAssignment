import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ChatScreen } from "../ui/ChatScreen.js";
import { JoinScreen } from "../ui/JoinScreen.js";
import { ChatController } from "./controller.js";

export function Application() {
  const [controller] = useState(() => new ChatController());
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { controller.start(); return () => controller.stop(); }, [controller]);
  useLayoutEffect(() => controller.flushLayout(), [controller, view]);
  return <div className="h-dvh min-h-0 bg-paper text-ink">
    {view.screen === "join" ? <JoinScreen view={view.join} onDisplayNameChange={controller.onJoinDisplayNameChange} onAdminPasswordChange={controller.onJoinAdminPasswordChange} onUseSavedIdentityChange={controller.onJoinUseSavedIdentityChange} onSubmit={controller.onJoinSubmit} />
      : <ChatScreen view={view.chat} callbacks={controller.callbacks} timelineDom={controller.timelineDom} composerDom={controller.composerDom} />}
  </div>;
}
