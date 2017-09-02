import { Document, Schema, model } from 'mongoose';

export type AccountModel = Document & {
	login: {
		id: string,
		provider: string,
	}
};

const accountLoginSchema = new Schema({
	id: String,
	provider: String,
});

accountLoginSchema.index({
	id: 1,
	provider: 1
}, { unique: true });

const accountSchema = new Schema({
	login: {
		type: accountLoginSchema,
		unique: true,
	}
}, { timestamps: true });

const Account = model('accounts', accountSchema);

export {Account};
