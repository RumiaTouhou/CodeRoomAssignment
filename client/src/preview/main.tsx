import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../ui/styles/global.css";
import { PreviewHost } from "./PreviewHost.js";
createRoot(document.getElementById("root")!).render(<StrictMode><PreviewHost /></StrictMode>);
