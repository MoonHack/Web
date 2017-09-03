import { Server as WSServer, IServerOptions as WSServerOptions } from 'ws'; 
import { Application } from 'express';
import { Server as HTTPServer } from 'http';

interface ExpressWs {
    getWss(): WSServer;
    applyTo(router: any): void;
}

interface ExpressWsOptions {
    leaveRouterUntouched: boolean;
    wsOptions: WSServerOptions;
}

declare function expressWs(app: Application, server?: HTTPServer, options?: ExpressWsOptions) : ExpressWs;

declare namespace expressWs {

}

export = expressWs;
