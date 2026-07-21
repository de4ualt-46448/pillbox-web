import { create } from "zustand";
import { api, setAccessToken, getAccessToken } from "../lib/api";
import type { AuthUser } from "../types";

interface AuthState {
  user: AuthUser | null;
  ready: boolean;
  bootstrap: () => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  signin: (email: string, password: string) => Promise<void>;
  signout: () => Promise<void>;
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  ready: false,

  // Restore a session from a persisted access token (or refresh cookie).
  bootstrap: async () => {
    const token = getAccessToken();
    if (!token) {
      set({ ready: true });
      return;
    }
    try {
      const { user } = await api.get<{ user: AuthUser }>("/auth/me");
      set({ user, ready: true });
    } catch {
      setAccessToken(null);
      set({ ready: true });
    }
  },

  signup: async (email, password) => {
    const { accessToken, user } = await api.post<{ accessToken: string; user: AuthUser }>(
      "/auth/signup",
      { email, password },
    );
    setAccessToken(accessToken);
    set({ user });
  },

  signin: async (email, password) => {
    const { accessToken, user } = await api.post<{ accessToken: string; user: AuthUser }>(
      "/auth/signin",
      { email, password },
    );
    setAccessToken(accessToken);
    set({ user });
  },

  signout: async () => {
    try {
      await api.post("/auth/signout");
    } catch {
      /* ignore */
    }
    setAccessToken(null);
    set({ user: null });
  },
}));
