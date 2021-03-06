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
import { Strategy as JWTStrategy } from 'passport-jwt';
import * as expressWs from 'express-ws';
import { connection } from './amqp';
import { v4 as uuidv4 } from 'uuid';
import { run } from './runner';
import * as path from 'path';
import { sign as signJwt } from 'jsonwebtoken';
import * as JSON5 from 'json5';

mongoose.connect(config.mongoUrl, {
	useNewUrlParser: true,
});
mongoose.set('useCreateIndex', true);
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

function asyncHandler(cb: (req: any, res: any) => Promise<void> | void) {
	return function (req: any, res: any, next: (err: Error) => void) {
		Bluebird.resolve(cb(req, res)).catch(next);
	}
}

function signReqJwt(req: any, res: any): Promise<boolean> {
	if (!req.user) {
		res.cookie('jwt', '', {
			maxAge: 0,
			signed: false,
			httpOnly: true,
		});
		return Promise.resolve(false);
	}
	return Account.findOne({
		_id: req.user.id,
	}, {
		miniat: 1,
	})
	.then(account => {
		if ((account as AccountModel).miniat > req.user.iat) {
			res.cookie('jwt', '', {
				maxAge: 0,
				signed: false,
				httpOnly: true,
			});
			return false;
		}
		return User.find({
			owner: req.user.id,
			retiredAt: { $exists: false },
		}, {
			name: 1,
		})
		.then(userNames => {
			res.cookie('jwt', signJwt({
				id: req.user.id,
				users: userNames.map(u => (u as UserModel).name),
			}, config.sessionSecret, {
				expiresIn: '1 hour',
			}), {
				maxAge: 1 * 60 * 60 * 1000,
				signed: false,
				httpOnly: true,
			});
			return true;
		});
	});
}

passport.use(new SteamStrategy({
		returnURL: `${config.publicUrl}api/v1/auth/steam/return`,
		realm: config.publicUrl,
		profile: false
	},
	(id: string, _profile: any, done: any) => {
		Account.findOne({
			'login.id': id,
			'login.provider': 'steam',
		}, {
			_id: 1,
		})
		.then(account => {
			if (account) {
				return account;
			}
			account = new Account({
				login: {
					id,
					provider: 'steam',
				},
				miniat: 0,
			});
			return account.save();
		})
		.then(account => {
			return done(null, {
				id: account._id,
			});
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
}, (data, done) => {
	done(null, data);
}));

app.use(cookieParser());
app.use(jsonBodyParser());
app.use(passport.initialize());
app.set('etag', false);

function canAccountUseUser(req: Express.Request, username: string): Promise<boolean> {
	if (!req || !req.isAuthenticated() || !username) {
		return Promise.resolve(false);
	}
	return Promise.resolve(req.user.users.includes(username));
}

app.get('/',
	(req, res, next) => {
		delete req.headers['if-modified-since'];
		delete req.headers['if-none-match'];
		res.header('Cache-Control', 'private');
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
	asyncHandler((req, res) => {
		res.header('Cache-Control', 'private');

		const username = req.body.username;
		const script = req.body.script;
		
		if (!username || !script) {
			res.sendStatus(400);
			res.end();
			return;
		}

		const args = req.body.args;
		
		let argsStr = '';
		if (args) {
			try {
				const argsObj = JSON5.parse(args);
				if (typeof argsObj !== 'object' || argsObj instanceof Array) {
					throw new Error('JSON args payload must be an object');
				}
				argsStr = JSON.stringify(argsObj);
			} catch(e) {
				res.status(400);
				res.send(e.message);
				res.end();
				return;				
			}
		}

		let w = req.body.width;
		if (w && typeof w !== 'number') {
			w = parseInt(w, 10);
		}
		let h = req.body.height;
		if (h && typeof h !== 'number') {
			h = parseInt(h, 10);
		}

		const infoStr = JSON.stringify({
			terminal: {
				width: w || undefined,
				height: h || undefined,
			},
		});

		return canAccountUseUser(req, username)
		.then(allowed => {
			if (!allowed) {
				res.sendStatus(403);
				res.end();
				return;
			}
			return run(username, script, argsStr, infoStr, res);
		});
	}));

app.get('/api/v1/users',
	passport.authenticate('jwt'),
	asyncHandler((req, res) => {
		res.header('Cache-Control', 'private');

		return User.find({
			owner: req.user.id,
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
			res.send(JSON.stringify(users));
			res.end();
		});
	}));

const VALID_USER_REGEX = /^[a-z_0-9]+$/;

app.post('/api/v1/users',
	passport.authenticate('jwt'),
	asyncHandler((req, res) => {
		res.header('Cache-Control', 'private');

		if (!VALID_USER_REGEX.test(req.body.username)) {
			res.status(400);
			res.send('Bad username');
			res.end();
			return;
		}

		const user = new User({
			owner: req.user.id,
			name: req.body.username,
		});

		return user.save()
		.then(() => {
			signReqJwt(req, res)
			.then(() => res.end());
		})
		.catch(() => {
			res.sendStatus(400);
			res.end();
		});
	}));

app.delete('/api/v1/users',
	passport.authenticate('jwt'),
	asyncHandler((req, res) => {
		res.header('Cache-Control', 'private');

		return User.findOneAndUpdate({
			owner: req.user.id,
			name: req.body.username,
			retiredAt: { $exists: false },
		}, {
			$set: {
				retiredAt: new Date(),
			},
		})
		.then(user => {
			if (user) {
				return signReqJwt(req, res)
				.then(() => res.end());
			} else {
				res.sendStatus(404);
				res.end();
			}
			return;
		});
	}));

app.ws('/api/v1/notifications',
	(ws, req) => {
		passport.authenticate('jwt', (err: any, account: any) => {
			function sendObject(obj: any): void {
				ws.send(JSON.stringify(obj));
			}

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

			req.user = account;

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
			ws.on('message', (dataStr) => {
				// TODO: Deal with JWT expiry
				const data = JSON.parse(dataStr.toString());
				switch (data.command) {
					case 'ping':
						sendObject({
							type: 'result',
							command: 'ping',
							ok: true,
						});
						break;
					case 'pong':
						// Ignore
						break;
					case 'userswitch':
						const username = data.user;
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
							return connection.completeConfiguration()
							.then(() => q.bind(notificationExchange, username))
							.then(() => q.activateConsumer((message) => {
								sendObject({
									type: 'notification',
									user: username,
									data: message.content.toString('utf8')
								});
							}, {
								noAck: true,
							}))
							.return();
						})
						.catch(err => {
							console.error(err.stack || err);
							close();
							ws.close();
						});
						break;
				}
			});

			ws.on('close', close);
			ws.on('error', close);

		})(req as any, null as any, null as any);
	});

app.post('/api/v1/auth/refresh',
	passport.authenticate('jwt'),
	asyncHandler((req, res) => {
		res.header('Cache-Control', 'private');

		return signReqJwt(req, res)
		.then(ok => {
			if (!ok) {
				res.sendStatus(401);
			}
			res.end();
		});
	}));

app.get('/api/v1/auth/steam',
	passport.authenticate('steam', { failureRedirect: '/' }),
	asyncHandler((_req, res) => {
		res.header('Cache-Control', 'private');

		res.redirect('/');
	}));

app.get('/api/v1/auth/steam/return',
	passport.authenticate('steam', { failureRedirect: '/' }),
	asyncHandler((req, res) => {
		res.header('Cache-Control', 'private');

		return signReqJwt(req, res)
		.then(() => res.redirect('/'));
	}));

app.post('/api/v1/auth/kill',
	passport.authenticate('jwt'),
	asyncHandler((req, res) => {
		res.header('Cache-Control', 'private');

		return Account.findOneAndUpdate({
			_id: req.user.id,
		}, {
			$set: {
				miniat: Math.ceil(Date.now() / 1000) + 10,
			},
		})
		.then(() => {
			res.end();
		});
	}));

app.use('/static', express.static('static'));

app.listen(process.env.PORT || config.port);
console.log('App listening');
