import type { AgentConnection, AgentObservation, InitPacket, Role } from "@app/shared/types";

export class AgentSession {
    private pending?: {
        resolve: (message: string) => void;
        reject: (error: Error) => void;
        timeoutId: ReturnType<typeof setTimeout>;
    };

    constructor(
        private readonly connection: AgentConnection,
        private readonly timeoutMs = 2000
    ) {}

    get role(): Role {
        return this.connection.role;
    }

    sendInit(packet: InitPacket): void {
        this.connection.send(JSON.stringify(packet));
    }

    requestAction(observation: AgentObservation): Promise<string> {
        if (this.pending) {
            throw new Error(`${this.role} already has a pending action request.`);
        }

        this.connection.send(JSON.stringify(observation));
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pending = undefined;
                reject(new Error(`${this.role} response timed out.`));
            }, this.timeoutMs);
            this.pending = { resolve, reject, timeoutId };
        });
    }

    receive(message: string): void {
        if (!this.pending) {
            throw new Error(`${this.role} sent an unexpected message: ${message}`);
        }
        const pending = this.pending;
        this.pending = undefined;
        clearTimeout(pending.timeoutId);
        pending.resolve(message.trim());
    }

    close(code?: number, reason?: string): void {
        this.connection.close(code, reason);
    }
}
