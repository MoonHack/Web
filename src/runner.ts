import * as Amqp from 'amqp-ts';
import { Writable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import Bluebird = require('bluebird');
import { connection } from './amqp';

const workQueue = connection.declareQueue('moonhack_command_jobs', {
	arguments: {
		'x-message-ttl': 30000,
	}
});

function encodeToMSG(run_id: string,
					caller: string,
					script: string,
					args: string): Amqp.Message {
	const run_id_b = Buffer.from(run_id, 'utf8');
	const caller_b = Buffer.from(caller, 'utf8');
	const script_b = Buffer.from(script, 'utf8');
	const args_b = Buffer.from(args, 'utf8');
	const struct_info_b = Buffer.allocUnsafe(4 * 4);
	struct_info_b.writeUInt32LE(run_id_b.byteLength, 0);
	struct_info_b.writeUInt32LE(caller_b.byteLength, 4);
	struct_info_b.writeUInt32LE(script_b.byteLength, 8);
	struct_info_b.writeUInt32LE(args_b.byteLength, 12);
	return new Amqp.Message(Buffer.concat([
		struct_info_b,
		run_id_b,
		caller_b,
		script_b,
		args_b,
	]));
}

export function run(caller: string,
					script: string,
					args: string,
					out: Writable): Bluebird<void> {
	const run_id = uuidv4();
	const msg = encodeToMSG(run_id, caller, script, args);
	const replyQueue = connection.declareQueue(`moonhack_command_results_${run_id}`, {
		autoDelete: true,
		arguments: {
			'x-expires': 60000,
		}
	});

	function stopConsumer() {
		out.end();
		return replyQueue.stopConsumer();
	}

	return connection.completeConfiguration()
	.then(() => {
		workQueue.send(msg);
		setTimeout(stopConsumer, 60000);
		return replyQueue.activateConsumer((message) => {
			out.write(message.content);
			if (message.content[0] === 1) {
				stopConsumer();
			}
		}, {
			noAck: true,
		});
	})
	.return();
}
