export type VoiceEngine = "LOCAL_TTS" | "CLONED_REMOTE" | "RECORDED";

export interface Medication {
  id: string;
  name: string;
  dosage: string;
  frequencyRaw: string;
  timesOfDay: string[];
  totalQuantity: number;
  pillsRemaining: number;
  quantityPerDose: number;
  notes: string;
  refillDate: string | null;
  voiceProfileId: string | null;
  lowStockThreshold: number;
  isLowStock: boolean;
  progressFraction: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoiceProfile {
  id: string;
  displayName: string;
  engine: VoiceEngine;
  localeTag: string | null;
  remoteVoiceId: string | null;
  audioPath: string | null;
  audioUrl: string | null;
  isDefault: boolean;
  createdAt: string;
}

export interface AuthUser {
  id: string;
  email: string;
}

export interface ParsedMedication {
  name: string | null;
  dosage: string | null;
  frequency: string | null;
  timesOfDay: string[];
  totalQuantity: number | null;
  quantityPerDose: number | null;
}

export interface DoseLogEntry {
  id: string;
  quantity: number;
  source: string;
  takenAt: string;
}
