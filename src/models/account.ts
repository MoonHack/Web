import { Document, Schema, model } from 'mongoose';

export interface AccountModel extends Document {
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
	provider: 1,
}, { unique: true });

const accountSchema = new Schema({
	login: {
		type: accountLoginSchema,
		unique: true,
	}
}, { timestamps: true });

export const Account = model('accounts', accountSchema);
