import { useNavigate, useLocation } from "react-router-dom";

/**
 * Floating bottom nav — three icons (add / inventory / schedule), matching the
 * Android PillboxBottomNav. "Schedule" navigates to the voice screen for now
 * (voice + reminders hub); wire to a dedicated schedule screen later.
 */
export function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const path = location.pathname;

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 w-[min(92%,420px)]">
      <div className="neumorphic-card flex items-center justify-between px-6 py-3">
        <NavIcon label="Add" selected={path === "/scanner"} onClick={() => navigate("/scanner")} emoji="➕" />
        <NavIcon label="Inventory" selected={path === "/"} onClick={() => navigate("/")} emoji="❤️" />
        <NavIcon label="Voices" selected={path === "/voice-profiles"} onClick={() => navigate("/voice-profiles")} emoji="🎙️" />
      </div>
    </div>
  );
}

function NavIcon({
  label,
  emoji,
  selected = false,
  onClick,
}: {
  label: string;
  emoji: string;
  selected?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      className={`w-11 h-11 rounded-full flex items-center justify-center text-xl transition-colors ${
        selected ? "bg-paleMint" : ""
      }`}
    >
      <span className={selected ? "grayscale-0" : "opacity-70"}>{emoji}</span>
    </button>
  );
}
