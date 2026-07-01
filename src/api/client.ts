import axios, { type AxiosError, type AxiosInstance, type AxiosRequestConfig } from "axios";
import { logger } from "../shared/logger.js";

function buildApiError(error: AxiosError): Error {
  const method = error.config?.method?.toUpperCase() ?? "GET";
  const url = error.config?.url ?? "(unknown-url)";
  const status = error.response?.status;
  const data = error.response?.data;
  const params = error.config?.params;

  let bodySnippet = "";
  if (typeof data === "string") {
    bodySnippet = data;
  } else if (data && typeof data === "object") {
    try {
      bodySnippet = JSON.stringify(data);
    } catch {
      bodySnippet = "[unserializable body]";
    }
  }

  const compactBody = bodySnippet.replace(/\s+/g, " ").trim().slice(0, 240);
  let compactParams = "";
  if (params && typeof params === "object") {
    try {
      compactParams = JSON.stringify(params).replace(/\s+/g, " ").trim().slice(0, 240);
    } catch {
      compactParams = "[unserializable params]";
    }
  }

  const base = `${method} ${url}${status ? ` -> ${status}` : ""}`;
  const withParams = compactParams ? `${base}; params=${compactParams}` : base;
  return compactBody ? new Error(`${withParams}; body=${compactBody}`) : new Error(withParams);
}

export interface ApiClientOptions {
  baseURL: string;
  getToken: () => Promise<string>;
  relogin: () => Promise<string>;
  onAuthExpired?: (context: { status: number; message: string }) => void;
}

export class ApiClient {
  private readonly http: AxiosInstance;

  constructor(private readonly options: ApiClientOptions) {
    this.http = axios.create({
      baseURL: options.baseURL,
      timeout: 15000, // 15s per request — fast-fail hung calls
    });

    this.http.interceptors.request.use(async (config) => {
      const token = await this.options.getToken();
      config.headers = config.headers ?? {};
      config.headers.Authorization = `Bearer ${token}`;
      return config;
    });

    this.http.interceptors.response.use(
      (response) => response,
      async (error: AxiosError) => {
        const status = error.response?.status;
        const original = error.config as (AxiosRequestConfig & { _retry?: boolean }) | undefined;
        if (status === 401 && original && !original._retry) {
          original._retry = true;
          this.options.onAuthExpired?.({ status: 401, message: "Session expired (401), can relogin and resume." });
          logger.warn("Nhan 401, thu dang nhap lai de lam moi token");
          const token = await this.options.relogin();
          original.headers = original.headers ?? {};
          (original.headers as Record<string, string>).Authorization = `Bearer ${token}`;
          return this.http.request(original);
        }

        throw buildApiError(error);
      },
    );
  }

  async get<T>(url: string, config?: AxiosRequestConfig): Promise<T> {
    const response = await this.http.get<T>(url, config);
    return response.data;
  }

  async getBuffer(url: string, config?: AxiosRequestConfig): Promise<Buffer> {
    const response = await this.http.get<ArrayBuffer>(url, { ...config, responseType: "arraybuffer" });
    return Buffer.from(response.data);
  }
}

export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 300): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }

  throw lastError;
}
