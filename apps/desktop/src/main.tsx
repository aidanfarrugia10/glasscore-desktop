/* @refresh reload */
import { render } from "solid-js/web";
import "./styles.css";
import App from "./App";
import Dock from "./pages/Dock";

const view = new URLSearchParams(location.search).get("view");
render(() => (view === "dock" ? <Dock /> : <App />), document.getElementById("root")!);
