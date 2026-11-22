// Conn mobile lab: web mocks of the iOS screens, for fast design iteration without the simulator.
// Open http://127.0.0.1:5801/. Screen, theme, state and scale live in the URL (see urlState.ts).
import ReactDOM from "react-dom/client";
import { MobileLab } from "./MobileLab";
import "./theme.generated.css";
import "./mobile.css";

ReactDOM.createRoot(document.getElementById("root")!).render(<MobileLab />);
