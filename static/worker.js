'use strict';

let ws, host, protocol, user, canRunCommand, wsErrored;
wsErrored = true;
console.log('Worker initialized');
setCanRunCommand(false);

function setCanRunCommand(can) {
	canRunCommand = can;
	updateStatus();
}

function reconnectWS() {
	if (!ws) {
		return;
	}
	ws.close();
	connectWs(ws);
}

function sendObject(obj) {
	if (ws) {
		ws.send(JSON.stringify(obj));
	}
}
setInterval(() => {
	if (pingInProgress) {
		return;
	}
	pingTime = Date.now();
	pingInProgress = true;
	updateStatus();
	sendObject({
		command: 'ping',
	});
}, 5 * 1000);

function sendRequest(method, url, data) {
	const headers = {};
	let body;
	if (data) {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify(data);
	}
	return fetch(url, {
		headers,
		method,
		body,
		credentials: 'same-origin',
	});
}

function refreshToken() {
	return sendRequest('post', '/api/v1/auth/refresh', null)
	.then((response) => {
		reconnectWS();
		return response;
	})
}
setInterval(refreshToken, 30 * 60 * 1000);

function sendCommand(cmd, args) {
	setCanRunCommand(false);

	let buffer = '';
	const decoder = new TextDecoder('utf-8');
	function handleProgress(value) {
		if (!value) {
			return;
		}
		buffer += decoder.decode(value);
		let i;
		while ((i = buffer.indexOf('\n')) >= 0) {
			if (buffer.charCodeAt(0) !== 1) {
				try {
					const data = JSON.parse(buffer.substr(0, i).trim());
					switch (data.type) {
						case 'return':
							addContentParsed(data.data);
							break;
						case 'print':
							if (data.initial) {
								addContentParsed(data.data);
							}
							break;
						case 'error':
							addContentParsed([false, data.data]);
							break;
					}
				} catch(e) {
					addContent(`Error ${e.message} parsing line: ${buffer.substr(0, i).trim()}`);
				}
			} else {
				const status = buffer.substr(1, i - 1).trim();
				switch (status) {
					case 'OK':
						// Do nothing, script has return
						break;
					case 'INTERNAL':
						addContentParsed([false, 'Internal error in scripting engine']);
						break;
					case 'MEMORY_LIMIT':
						addContentParsed([false, 'Script hit memory limit and was terminated']);
						break;
					case 'SOFT_TIMEOUT':
					case 'HARD_TIMEOUT':
						addContentParsed([false, 'Script hit 5 second timeout and was terminated']);
						break;
					default:
						addContentParsed([false, 'Unknown result code: ' + status]);
						break;
				}
			}
			if (i === buffer.length - 1) {
				buffer = '';
			} else {
				buffer = buffer.substr(i + 1);
			}
		}
	}

	return sendRequest('post', '/api/v1/run', {
		username: user,
		script: cmd,
		args: args,
	})
	.then((response) => {
		if (!response.ok) {
			return response.text()
			.then(body => {
				addContentParsed([false, body]);
				setCanRunCommand(true);
			});
		}
		const reader = response.body.getReader();
		function next() {
			reader.read()
			.then(({ value, done }) => {
				handleProgress(value);
				if (done) {
					setCanRunCommand(true);
					return;
				}
				next();
			});
		}
		next();
	});
}

function connectWs(_ws) {
	if (_ws !== ws) {
		return;
	}
	_ws = new WebSocket(((protocol === 'https:') ? 'wss://' : 'ws://') + host + '/api/v1/notifications');
	ws = _ws;
	
	ws.onmessage = _msg => {
		const msg = JSON.parse(_msg.data);
		switch (msg.type) {
			case 'result':
				switch (msg.command) {
					case 'userswitch':
						if (!msg.ok) {
							addContent('Error switching user to ' + msg.user + ': ' + msg.error);
							if (user === msg.user) {
								user = null;
							}
						} else if (user !== msg.user) {
							addContent('Switched user to ' + msg.user);
							user = msg.user;
						}
						setCanRunCommand(true);
						break;
					case 'connect':
						if (!msg.ok) {
							postMessage(['reload']);
						} else {
							if (wsErrored) {
								addContent('Connected to MoonHack');
							}
							if (user) {
								sendObject({
									command: 'userswitch',
									user: user,
								});
							} else if(wsErrored) {
								listUsers();
							}
							wsErrored = false;
							pingInProgress = false;
						}
						break;
					case 'ping':
						pingInProgress = false;
						pingLatency = Date.now() - pingTime;
						updateStatus();
						break;
				}
				break;
			case 'command':
				switch (msg.command) {
					case 'ping':
						sendObject({
							command: 'pong',
						});
						break;
				}
				break;
		}
	};

	ws.onclose = e => {
		setCanRunCommand(false);
		setTimeout(() => connectWs(_ws), 2000);
	};

	ws.onerror = e => {
		setCanRunCommand(false);
		addContent('Connection to MoonHack errored: ' + e);
		wsErrored = true;
		setTimeout(() => connectWs(_ws), 2000);
	};
}

function listUsers() {
	sendRequest('get', '/api/v1/users', null)
	.then((response) => {
		setCanRunCommand(true);
		if (!response.ok) {
			addContent('Error getting user list');
			return;
		}
		return response.json()
		.then((data) => {
			const users = [];
			const rUsers = [];
			data.forEach(u => {
				const un = u.name;
				if (u.retiredAt) {
					rUsers.push(un);
				} else {
					users.push(un);
				}
			});
			addContent('Users: ' + users.join(', '));
			addContent('Retired users: ' + rUsers.join(', '));
		});
	});
}

onmessage = msg => {
	msg = msg.data;
	switch (msg[0]) {
		case 'init':
			host = msg[1];
			protocol = msg[2];
			refreshToken().then(() => connectWs());
			break;
		case 'user':
			setCanRunCommand(false);
			sendObject({
				command: 'userswitch',
				user: msg[1],
			});
			break;
		case 'lsuser':
			listUsers();
			break;
		case 'mkuser':
			setCanRunCommand(false);
			sendRequest('post', '/api/v1/users', {
				username: msg[1],
			})
			.then(response => {
				if (response.ok) {
					addContent('user created');
				} else {
					addContent('could not create user');
				}
				reconnectWS();
				setCanRunCommand(true);
			});
			break;
		case 'rmuser':
			setCanRunCommand(false);
			sendRequest('delete', '/api/v1/users', {
				username: msg[1],
			})
			.then(response => {
				if (response.ok) {
					addContent('user retired');
				} else {
					addContent('could not retired user');
				}
				reconnectWS();
				setCanRunCommand(true);
			});
			break;
		case 'command':
			if (!user) {
				addContent('please select a user first');
				return;
			}
			setCanRunCommand(false);
			sendCommand(msg[1], msg[2]);
			break;
	}
}

let pingTime = 0, pingLatency = 0, pingInProgress = false;

function padStatusText(str, len, padStr = '&nbsp;') {
	str = str.toString();
	if (str.length >= len) {
		return str;
	}
	return str + padStr.repeat(len - str.length);
}

function padStatusNumber(str, len, padStr = '&nbsp;') {
	str = str.toString();
	if (str.length >= len) {
		return str;
	}
	return padStr.repeat(len - str.length) + str;
}

function updateStatus() {
	if (!user) {
		return;
	}

	postMessage(['status',`
		User: ${padStatusText(user, 32)} |
		Input: <span style="color: #${canRunCommand ? '00ff00;">yes' : 'ff0000;">no&nbsp;'}</span> |
		Ping: <span style="${pingInProgress ? 'color: #ffff00;' : ''}">${padStatusText(pingLatency, 4)}ms</span>
	`,`${canRunCommand ? 'IDL' : 'BSY'} ${user} - MHWeb`]);
}

updateStatus();

let shellContent = [], shellDebounceTimer = null;

function postShell() {
	shellDebounceTimer = null;
	const c = shellContent.join('\n') + '\n';
	shellContent = [];
	postMessage(['shell',c]);
}

function addContentParsed(d) {
	if (d instanceof Array) {
		if (d.length === 2 && (d[0] === true || d[0] === false)) {
			addContentFormatted(d[0] ? 'Success': 'Failure');
			addContentFormatted(d[1]);
			return;
		} else if (d.length === 1) {
			addContentFormatted(d[0]);
			return;
		}
	} else if (typeof d === 'object') {
		const k = Object.keys(d).length;
		if (k === 1 && d.msg !== undefined) {
			addContentFormatted(d.msg);
			return;
		} else if (k === 2 && d.ok !== undefined && d.msg !== undefined) {
			addContentParsed([d.ok, d.msg]);
			return;
		}
	}
	addContentFormatted(d);
}

function addContentFormatted(d) {
	if (typeof d === 'string') {
		addContent(d);
	} else {
		addContent(JSON.stringify(d, null, '\t'));
	}
}

function addContent(content) {
	content = content.replace(/&/g, '&amp;')
					.replace(/</g, '&lt;')
					.replace(/>/g, '&gt;');
	shellContent.push(content);
	if (shellDebounceTimer !== null) {
		clearTimeout(shellDebounceTimer);
	}
	shellDebounceTimer = setTimeout(postShell, 10);
}

postMessage(['init' ]);
