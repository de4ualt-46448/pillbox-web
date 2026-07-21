import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { hardwareClient } from "./mqttClient";
import type { Medication, VoiceProfile, DoseLogEntry } from "../types";

export const medKeys = {
  all: ["medications"] as const,
};

export function useMedications() {
  return useQuery({
    queryKey: medKeys.all,
    queryFn: () => api.get<Medication[]>("/medications"),
  });
}

export function useCreateMedication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Partial<Medication> & { timesOfDay?: string[]; totalQuantity: number }) =>
      api.post<Medication>("/medications", input),
    onSuccess: () => { qc.invalidateQueries({ queryKey: medKeys.all }); hardwareClient.refreshSchedule(); },
  });
}

export function useUpdateMedication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...patch }: { id: string } & Record<string, unknown>) =>
      api.patch<Medication>(`/medications/${id}`, patch),
    onSuccess: () => { qc.invalidateQueries({ queryKey: medKeys.all }); hardwareClient.refreshSchedule(); },
  });
}

export function useDeleteMedication() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/medications/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: medKeys.all }); hardwareClient.refreshSchedule(); },
  });
}

export function useSetStock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, pillsRemaining }: { id: string; pillsRemaining: number }) =>
      api.patch<Medication>(`/medications/${id}/stock`, { pillsRemaining }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: medKeys.all }); hardwareClient.refreshSchedule(); },
  });
}

export function useRecordDose() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, quantity }: { id: string; quantity?: number }) =>
      api.post<Medication>(`/medications/${id}/dose-taken`, quantity ? { quantity } : {}),
    onSuccess: () => { qc.invalidateQueries({ queryKey: medKeys.all }); hardwareClient.refreshSchedule(); },
  });
}

export function useDoseHistory(medicationId: string, limit = 50) {
  return useQuery({
    queryKey: [...medKeys.all, "dose-history", medicationId],
    queryFn: () => api.get<DoseLogEntry[]>(`/medications/${medicationId}/dose-history?limit=${limit}`),
    enabled: !!medicationId,
  });
}

export const voiceKeys = {
  all: ["voice-profiles"] as const,
};

export function useVoiceProfiles() {
  return useQuery({
    queryKey: voiceKeys.all,
    queryFn: () => api.get<VoiceProfile[]>("/voice"),
  });
}

export function useCreateLocalVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { displayName: string; localeTag?: string }) =>
      api.post<VoiceProfile>("/voice", input),
    onSuccess: () => qc.invalidateQueries({ queryKey: voiceKeys.all }),
  });
}

export function useCloneVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.upload<VoiceProfile>("/voice/clone", form),
    onSuccess: () => qc.invalidateQueries({ queryKey: voiceKeys.all }),
  });
}

export function useRecordedVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (form: FormData) => api.upload<VoiceProfile>("/voice/record", form),
    onSuccess: () => qc.invalidateQueries({ queryKey: voiceKeys.all }),
  });
}

export function useDeleteVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.del(`/voice/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: voiceKeys.all }),
  });
}

export function useSetDefaultVoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/voice/${id}/default`),
    onSuccess: () => qc.invalidateQueries({ queryKey: voiceKeys.all }),
  });
}
