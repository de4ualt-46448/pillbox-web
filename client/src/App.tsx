import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import type { ReactNode } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "./lib/queryClient";
import { useAuth } from "./store/auth";
import { Layout } from "./components/Layout";
import { SignIn, SignUp } from "./screens/Auth";
import { Inventory } from "./screens/Inventory";
import { MedicationDetail } from "./screens/MedicationDetail";
import { Scanner } from "./screens/Scanner";
import { ScanReview } from "./screens/ScanReview";
import { VoiceProfiles } from "./screens/VoiceProfiles";

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="min-h-screen flex items-center justify-center text-textSecondary">Loading…</div>;
  if (!user) return <Navigate to="/signin" replace />;
  return <>{children}</>;
}

export default function App() {
  const { bootstrap } = useAuth();

  // bootstrap is called once via effect in main.tsx; here we just render.
  void bootstrap;

  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/signup" element={<SignUp />} />
          <Route
            path="/"
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route index element={<Inventory />} />
            <Route path="scanner" element={<Scanner />} />
            <Route path="scan-review" element={<ScanReview />} />
            <Route path="medication/:id" element={<MedicationDetail />} />
            <Route path="voice-profiles" element={<VoiceProfiles />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
