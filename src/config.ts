export const config = {
	"amqpUrl": process.env.RMQ_URL!,
	"mongoUrl": process.env.MONGODB_CORE!,
	"publicUrl": process.env.PUBLIC_URL!,
	"sessionSecret": process.env.SESSION_SECRET!,
	"port": parseInt(process.env.PORT!, 10),
};

