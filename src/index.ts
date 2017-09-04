import * as Amqp from 'amqp-ts';
import { Account } from './models/account';
import {  User, UserModel } from './models/user';
import * as passport from 'passport';
import * as mongoose from 'mongoose';
import { Strategy as SteamStrategy } from 'passport-steam';
import * as express from 'express';
import * as Bluebird from 'bluebird';
import { config } from './config';
import { json as jsonBodyParser } from 'body-parser';
import * as cookieParser from 'cookie-parser';
import { Strategy as JWTStrategy } from 'passport-jwt';
import * as expressWs from 'express-ws';
import { connection } from './amqp';
import { v4 as uuidv4 } from 'uuid';
import { run } from './runner';
import * as path from 'path';
import { sign as signJwt } from 'jsonwebtoken';

mongoose.connect(config.mongoUrl, {
	useMongoClient: true,
});
(<any>mongoose).Promise = Bluebird; // mongoose wants this!

const app = express();
expressWs(app);

passport.serializeUser((user, done) => {
	done(null, user);
});

passport.deserializeUser((obj, done) => {
	done(null, obj);
});

const notificationExchange = connection.declareExchange(
	"moonhack_notifications",
	"topic",
	{
		durable: true,
	}
);

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
			return done(null, account._id);
		})
		.catch(done);
	})
);

passport.use(new JWTStrategy({
	secretOrKey: config.sessionSecret,
	jwtFromRequest: (req: any) => {
		if (req.cookies && req.cookies.jwt) {
			return req.cookies.jwt;
		}
		return null;
	},
}, (id, done) => {
	done(null, id.id);
}));

app.use(cookieParser());
app.use(jsonBodyParser());
app.use(passport.initialize());

function canAccountUseUser(req: Express.Request, username: string): Promise<boolean> {
	if (!req || !req.isAuthenticated() || !username) {
		return Promise.resolve(false);
	}
	return User.findOne({
		owner: req.user,
		name: username,
		retiredAt: { $exists: false },
	})
	.then(user => {
		return !!user;
	});
}

app.get('/',
	(req, res, next) => {
		passport.authenticate('jwt', (err: any,  user: any) => {
			if (err || !user) {
				res.sendFile(path.resolve('views/auth.html'));
				return;
			}
			res.sendFile(path.resolve('views/index.html'));
		})(req, res, next);
	});

app.post('/api/v1/run',
	passport.authenticate('jwt'),
	(req, res) => {
		const username = req.body.username;
		const script = req.body.script;
		const args = req.body.args || '';
		if (!username || !script || (args.length > 0 && args[0] !== '{')) {
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
	passport.authenticate('jwt'),
	(req, res) => {
		User.find({
			owner: req.user,
		})
		.then(users => {
			return (users as UserModel[]).map(user => {
				return {
					_id: user._id,
					name: user.name,
					retiredAt: user.retiredAt,
				};
			});
		})
		.then(users => {
			res.write(JSON.stringify(users));
			res.end();
		});
	});

app.post('/api/v1/users',
	passport.authenticate('jwt'),
	(req, res) => {
		const user = new User({
			owner: req.user,
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
	passport.authenticate('jwt'),
	(req, res) => {
		User.findOneAndUpdate({
			owner: req.user,
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
		passport.authenticate('jwt', (err: any, account: any) => {
			function sendObject(obj: any): void {
				ws.send(JSON.stringify(obj));
			}
			req.user = account;

			if (err || !account) {
				sendObject({
					type: 'result',
					command: 'connect',
					ok: false,
					error: 'Forbidden',
				});
				ws.close();
				return;
			}

			sendObject({
				type: 'result',
				command: 'connect',
				ok: true,
			});

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
							type: 'result',
							command: 'userswitch',
							ok: false,
							user: username,
							error: 'Forbidden',
						});
						return;
					}

					sendObject({
						type: 'result',
						command: 'userswitch',
						ok: true,
						user: username,
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
						sendObject({
							type: 'notification',
							user: username,
							data: message.content.toString('utf8')
						});
					}, {
						noAck: true,
					}));
				});
			});

			ws.on('close', close);
			ws.on('error', close);

		})(req as any, null as any, null as any);
	});

function signReqJwt(req: any, res: any) {
	res.cookie('jwt', signJwt({
		id: req.user,
	}, config.sessionSecret, {
		expiresIn: '1 hour',
	}), {
		maxAge: 1 * 60 * 60 * 1000,
		signed: false,
		httpOnly: true,
	});
}

app.post('/api/v1/auth/refresh',
	passport.authenticate('jwt'),
	(req, res) => {
		signReqJwt(req, res);
		res.end();
	});

app.get('/api/v1/auth/steam',
	passport.authenticate('steam', { failureRedirect: '/' }),
	(_req, res) => {
		res.redirect('/');
	});

app.get('/api/v1/auth/steam/return',
	passport.authenticate('steam', { failureRedirect: '/' }),
	(req, res) => {
		signReqJwt(req, res);
		res.redirect('/');
	});

app.use('/static', express.static('static'));

app.listen(process.env.PORT || config.port);
console.log('App listening');
