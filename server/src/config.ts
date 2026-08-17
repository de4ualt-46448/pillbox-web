import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  CLIENT_ORIGIN: z.string().optional(),
  ELEVENLABS_API_KEY: z.string().default(""),
  NVIDIA_API_KEY: z.string().default(""),
  NVIDIA_BASE_URL: z.string().default("https://integrate.api.nvidia.com/v1"),
  NVIDIA_OCR_MODEL: z.string().default("meta/llama-3.2-90b-vision-instruct"),
  UPLOAD_DIR: z.string().default("uploads"),
  JWT_SECRET: z.string().min(1, "JWT_SECRET is required"),
  JWT_REFRESH_SECRET: z.string().min(1, "JWT_REFRESH_SECRET is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  MQTT_BROKER_URL: z.string().optional(),
  GROQ_API_KEY: z.string().default(""),
  GROQ_BASE_URL: z.string().default("https://api.groq.com/openai/v1"),
  GROQ_OCR_MODEL: z.string().default("qwen/qwen3.6-27b"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_OCR_MODEL: z.string().default("gpt-4o"),
  OCR_PROVIDER: z.enum(["auto", "nvidia", "openai", "groq"]).default("auto"),
  OCR_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(60000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("[server] Invalid environment variables:");
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const env = parsed.data;

export const PORT = env.PORT;
export const HOST = env.HOST;
export const WS_PATH = "/ws/hardware";
export const CLIENT_ORIGIN = env.CLIENT_ORIGIN;
export const ELEVENLABS_API_KEY = env.ELEVENLABS_API_KEY;
export const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
export const NVIDIA_API_KEY = env.NVIDIA_API_KEY;
export const NVIDIA_BASE_URL = env.NVIDIA_BASE_URL;
export const NVIDIA_OCR_MODEL = env.NVIDIA_OCR_MODEL;
export const UPLOAD_DIR = env.UPLOAD_DIR;
export const JWT_SECRET = env.JWT_SECRET;
export const JWT_REFRESH_SECRET = env.JWT_REFRESH_SECRET;
export const MQTT_BROKER_URL = env.MQTT_BROKER_URL;
export const GROQ_API_KEY = env.GROQ_API_KEY;
export const GROQ_BASE_URL = env.GROQ_BASE_URL;
export const GROQ_OCR_MODEL = env.GROQ_OCR_MODEL;
export const OPENAI_API_KEY = env.OPENAI_API_KEY;
export const OPENAI_OCR_MODEL = env.OPENAI_OCR_MODEL;
export const OCR_PROVIDER = env.OCR_PROVIDER;
export const OCR_TIMEOUT_MS = env.OCR_TIMEOUT_MS;
