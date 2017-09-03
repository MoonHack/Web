import * as Amqp from 'amqp-ts';
import { Account, AccountModel } from './models/account';
import {  User, UserModel } from './models/user';
import * as passport from 'passport';
import * as mongoose from 'mongoose';
import { Strategy as SteamStrategy } from 'passport-steam';
import * as express from 'express';
import * as Bluebird from 'bluebird';
import { config } from './config';
import { json as jsonBodyParser } from 'body-parser';
import * as cookieParser from 'cookie-parser';
import * as expressWs from 'express-ws';
import * as session from 'express-session';
import { connection } from './amqp';
import { v4 as uuidv4 } from 'uuid';
import { run } from './runner';

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
		})
		.catch(done);
	})
);

app.use(cookieParser());
app.use(jsonBodyParser());
app.use(session({
	secret: config.sessionSecret,
	resave: false,
	saveUninitialized: false,
}));
app.use(passport.initialize());
app.use(passport.session());

function canAccountUseUser(req: Express.Request, username: string): Promise<boolean> {
	if (!req || !req.isAuthenticated() || !username) {
		return Promise.resolve(false);
	}
	return User.findOne({
		owner: req.user._id,
		name: username,
	})
	.then(user => {
		return !!user;
	})
}

app.get('/',
	(req, res) => {
		if (!req.isAuthenticated()) {
			res.sendFile('/views/auth.html');
			return;
		}
		res.sendFile('/views/index.html');
	});

app.post('/api/v1/run',
	(req, res) => {
		if (!req.isAuthenticated()) {
			res.sendStatus(401);
			res.end();
			return;
		}

		const username = req.body.username;
		const script = req.body.script;
		const args = req.body.args ? JSON.stringify(req.body.args) : '';
		if (!username || !script) {
			res.sendStatus(400);
			res.end();
			return;
		}

		canAccountUseUser(req, username)
		.then(allowed => {
			if (!allowed) {
				res.sendStatus(403);
				res.end();
				return;
			}
			return run(username, script, args, res);
		})
	});

app.get('/api/v1/users',
	(req, res) => {
		if (!req.isAuthenticated()) {
			res.sendStatus(401);
			res.end();
			return;
		}

		User.find({
			owner: req.user._id,
		})
		.then(users => {
			(users as UserModel[]).forEach(user => {
				res.write({
					_id: user._id,
					name: user.name,
					retiredAt: user.retiredAt,
				});
			});
			res.end();
		});
	});

app.post('/api/v1/users',
	(req, res) => {
		if (!req.isAuthenticated()) {
			res.sendStatus(401);
			res.end();
			return;
		}

		const user = new User({
			owner: req.user._id,
			name: req.body.username,
		});
		user.save()
		.then(() => {
			res.sendStatus(200);
			res.end();
		})
		.catch(() => {
			res.sendStatus(400);
			res.end();
		});
	});

app.delete('/api/v1/users',
	(req, res) => {
		if (!req.isAuthenticated()) {
			res.sendStatus(401);
			res.end();
			return;
		}
		User.findOneAndUpdate({
			owner: req.user._id,
			name: req.body.username,
			retiredAt: { $exists: false },
		}, {
			$set: {
				retiredAt: new Date(),
			},
		})
		.then(user => {
			if (user) {
				res.sendStatus(200);
				res.end();
			} else {
				res.sendStatus(404);
				res.end();
			}
		})
	})

app.ws('/api/v1/notifications',
	(ws, req) => {
		function sendObject(obj: any): void {
			ws.send(JSON.stringify(obj));
		}

		if (!req.isAuthenticated()) {
			sendObject({
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
			
			canAccountUseUser(req,  username)
			.then(allowed => {
				if (!allowed) {
					sendObject({
						ok: false,
						error: 'Unauthorized',
					});
					return;
				}

				sendObject({
					ok: true,
				});
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
