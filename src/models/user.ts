import { Document, Schema, model } from 'mongoose';

export type UserModel = Document & {
	name: string,
	owner: Schema.Types.ObjectId,
};

const userSchema = new Schema({
	name: String,
	owner: Schema.Types.ObjectId,
}, { timestamps: true });

const User = model('users', userSchema);

export {User};
