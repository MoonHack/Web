import { Document, Schema, model } from 'mongoose';

export interface UserModel extends Document {
	name: string,
	owner: Schema.Types.ObjectId,
	retiredAt: Date,
};

const userSchema = new Schema({
	name: {
		type: String,
		unique: true,
	},
	owner: Schema.Types.ObjectId,
	retiredAt: Date,
}, { timestamps: true });

userSchema.index({
	name: 1,
}, { unique: true });

userSchema.index({
	retiredAt: 1,
});

export const User = model('users', userSchema);
