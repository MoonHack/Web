import * as Amqp from 'amqp-ts';
import { config } from './config';

export const connection = new Amqp.Connection(config.amqpUrl);
