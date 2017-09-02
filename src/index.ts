import { Account, AccountModel } from './models/account';
import * as passport from 'passport';;
import * as mongoose from 'mongoose';
import { Strategy as SteamStrategy } from 'passport-steam';
import * as express from 'express';
import * as Bluebird from 'bluebird';
import { config } from './config';

mongoose.connect(config.mongoUrl, {
	useMongoClient: true,
});
(<any>mongoose).Promise = Bluebird; // mongoose wants this!

const app = express();

passport.serializeUser<AccountModel, mongoose.Schema.Types.ObjectId>((account, done) => {
	done(null, account._id);
});

passport.deserializeUser<AccountModel, mongoose.Schema.Types.ObjectId>((obj, done) => {
	Account.findById(obj).then(account => {
		done(null, account as AccountModel);
	}).catch(done);
});

passport.use(new SteamStrategy({
		returnURL: `${config.publicUrl}auth/steam/return`,
		realm: config.publicUrl,
		profile: false
	},
	(id: string, _profile: any, done: any) => {
		Account.findOne({
			login: {
				id,
				provider: 'steam'
			}
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

app.use(passport.initialize());

app.get('/auth/steam',
	passport.authenticate('steam', { failureRedirect: '/' }),
	(_req, res) => {
		res.redirect('/');
	});

app.get('/auth/steam/return',
	passport.authenticate('steam', { failureRedirect: '/' }),
	(_req, res) => {
		res.redirect('/');
	});

app.listen(process.env.PORT || config.port);
