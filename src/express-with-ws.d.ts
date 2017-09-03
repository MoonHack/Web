import { Request } from 'express'
import * as WebSocket from 'ws';

declare global {
    namespace Express {
        export interface Application {
            ws(route: string, callback: (ws: WebSocket, req: Request) => void): void;
        }
    }
}
