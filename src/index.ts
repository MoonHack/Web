import * as Amqp from 'amqp-ts';
import { Account, AccountModel } from './models/account';
import * as passport from 'passport';
import * as mongoose from 'mongoose';
import { Strategy as SteamStrategy } from 'passport-steam';
import * as express from 'express';
import * as Bluebird from 'bluebird';
import { config } from './config';
import { json as jsonBodyParser } from 'body-parser';
import * as expressWs from 'express-ws';
import * as WebSocket from 'ws';
import { connection } from './amqp';
import { v4 as uuidv4 } from 'uuid';

mongoose.connect(config.mongoUrl, {
	useMongoClient: true,
});
(<any>mongoose).Promise = Bluebird; // mongoose wants this!

const app = express();
expressWs(app);

const notificationExchange = connection.declareExchange(
	"moonhack_notifications",
	"topic",
	{
		durable: true,
	}
);

passport.serializeUser<AccountModel, mongoose.Schema.Types.ObjectId>((account, done) => {
	done(null, account._id);
});

passport.deserializeUser<AccountModel, mongoose.Schema.Types.ObjectId>((obj, done) => {
	Account.findById(obj).then(account => {
		done(null, account as AccountModel);
	}).catch(done);
});

passport.use(new SteamStrategy({
		returnURL: `${config.publicUrl}api/v1/auth/steam/return`,
		realm: config.publicUrl,
		profile: false
	},
	(id: string, _profile: any, done: any) => {
		Account.findOne({
			'login.id': id,
			'login.provider': 'steam',
		})
		.then(account => {
			if (account) {
				return account;
			}
			account = new Account({
				login: {
					id,
					provider: 'steam',
				}
			});
			return account.save();
		})
		.then(account => {
			return done(null, account);
		}).catch(done);
	})
);

app.use(jsonBodyParser());
app.use(passport.initialize());
app.use(passport.session());

app.get('/',
	(req, res) => {
		if (!req.isAuthenticated()) {
			res.sendFile('/views/auth.html');
			return;
		}
		res.sendFile('/views/index.html');

	});

function sendObject(ws: WebSocket, obj: any): void {
	ws.send(JSON.stringify(obj));
}

app.ws('/api/v1/notifications',
	(ws, req) => {
		if (!req.isAuthenticated()) {
			sendObject(ws, {
				ok: false,
				error: 'Unauthorized',
			});
			ws.close();
			return;
		}

		let queue: Amqp.Queue|undefined = undefined;
		function close() {
			if (queue) {
				queue.close();
				queue = undefined;
			}
		}
		ws.on('message', (data) => {
			const username = data.toString();
			close();
			const q = connection.declareQueue(
				`moonhack_notification_listener_${uuidv4()}`,
				{
					exclusive: true,
				}
			);
			queue = q;
			connection.completeConfiguration()
			.then(() => q.bind(notificationExchange, username))
			.then(() => q.activateConsumer((message) => {
				ws.send(message.content.toString('utf8'));
			}, {
				noAck: true,
			}));
		});

		ws.on('close', close);
		ws.on('error', close);
	});

app.get('/api/v1/auth/steam',
	passport.authenticate('steam', { failureRedirect: '/' }),
	(_req, res) => {
		res.redirect('/');
	});

app.get('/api/v1/auth/steam/return',
	passport.authenticate('steam', { failureRedirect: '/' }),
	(_req, res) => {
		res.redirect('/');
	});

app.use('/static', express.static('static'));

app.listen(process.env.PORT || config.port);
