import type {
    IntelligenceMatrix,
    MatchHistoryStats,
    MatchReplay,
    MatchStartRequest,
    MatchSummary,
    StatusMessage,
} from "@app/shared/types";

export type JsonResponse<T> = Response & { json(): Promise<T> };

export type MatchStartResponse =
    | { ok: true; accepted: number }
    | {
          ok: false;
          reason: "invalid-count" | "invalid-level" | "capacity-exceeded" | "runner-start-failed";
      };

export type MatrixStartRequest = {
    duckLevels?: number[];
    sphinxLevels?: number[];
    trialsPerCell?: number;
    count?: number;
    seed?: number;
};

export type MatrixStartResponse =
    | { ok: true; accepted: number; matrixRunId: string }
    | {
          ok: false;
          reason:
              | "invalid-matrix"
              | "invalid-count"
              | "invalid-level"
              | "capacity-exceeded"
              | "runner-start-failed";
          accepted?: number;
      };

export type ConcurrencyUpdateResponse =
    { ok: true; status: StatusMessage } | { ok: false; reason: "invalid-concurrency" };

export interface ApiClient {
    api: {
        matches: {
            $get(): Promise<JsonResponse<MatchSummary[]>>;
            $post(args: { json: MatchStartRequest }): Promise<JsonResponse<MatchStartResponse>>;
            $delete(): Promise<JsonResponse<{ deleted: number }>>;
            stats: {
                $get(): Promise<JsonResponse<MatchHistoryStats>>;
            };
            status: {
                $get(): Promise<JsonResponse<StatusMessage>>;
            };
            concurrency: {
                $put(args: {
                    json: {
                        maxConcurrentMatches: number;
                    };
                }): Promise<JsonResponse<ConcurrencyUpdateResponse>>;
            };
            "intelligence-matrix": {
                $get(args?: {
                    query?: {
                        matrixRunId?: string;
                    };
                }): Promise<JsonResponse<IntelligenceMatrix>>;
                $post(args: {
                    json: MatrixStartRequest;
                }): Promise<JsonResponse<MatrixStartResponse>>;
            };
            ":id": {
                $get(args: {
                    param: { id: string };
                }): Promise<JsonResponse<MatchReplay | { error: string }>>;
            };
        };
        ws: {
            view: {
                $ws(): WebSocket;
            };
        };
    };
}

export type AppType = ApiClient;
