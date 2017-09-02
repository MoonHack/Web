import { Document, Schema, model } from 'mongoose';

export interface UserModel extends Document {
	name: string,
	owner: Schema.Types.ObjectId,
};

const userSchema = new Schema({
	name: String,
	owner: Schema.Types.ObjectId,
}, { timestamps: true });

export const User = model('users', userSchema);
