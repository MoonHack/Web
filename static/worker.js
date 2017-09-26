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

function sendRequest(method, url, data, cb) {
	const xhr = new XMLHttpRequest();
	xhr.open(method, url);
	if (cb) {
		xhr.onreadystatechange = () => {
			if (xhr.readyState !== 4) {
				return;
			}
			cb(xhr);
		};
	}
	if (data) {
		xhr.setRequestHeader('Content-Type', 'application/json');
		xhr.send(JSON.stringify(data));	
	} else {
		xhr.send();
	}
	return xhr;
}

function refreshToken(cb) {
	if (!cb) {
		cb = reconnectWS;
	}
	sendRequest('post', '/api/v1/auth/refresh', null, cb);
}
setInterval(refreshToken, 30 * 60 * 1000);

function sendCommand(cmd, args) {
	setCanRunCommand(false);
	const xhr = sendRequest('post', '/api/v1/run', {
		username: user,
		script: cmd,
		args: args,
	}, (xhr) => {
		if (xhr.status !== 200) {
			addContentParsed([false, xhr.responseText]);
		}
		setCanRunCommand(true);
	});
	let lastProgress = 0;
	let buffer = '';
	function handleProgress(pe) {
		const added = xhr.responseText.substr(lastProgress);
		buffer += added;
		let i;
		while ((i = buffer.indexOf('\n')) >= 0) {
			if (buffer.charCodeAt(0) !== 1) {
				const data = JSON.parse(buffer.substr(0, i));
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
			}
			if (i === buffer.length - 1) {
				buffer = '';
			} else {
				buffer = buffer.substr(i + 1);
			}
		}
		lastProgress = pe.loaded;
	}
	xhr.onprogress = handleProgress;
	xhr.onloadend = handleProgress;
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
	sendRequest('get', '/api/v1/users', null, xhr => {
		setCanRunCommand(true);
		if (xhr.status !== 200) {
			addContent('Error getting user list');
			return;
		}
		const data = JSON.parse(xhr.responseText);
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
}

onmessage = msg => {
	msg = msg.data;
	switch (msg[0]) {
		case 'init':
			host = msg[1];
			protocol = msg[2];
			refreshToken(() => connectWs());
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
			}, xhr => {
				if (xhr.status >= 200 && xhr.status <= 299) {
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
			}, xhr => {
				if (xhr.status >= 200 && xhr.status <= 299) {
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
	shellContent.push(content);
	if (shellDebounceTimer !== null) {
		clearTimeout(shellDebounceTimer);
	}
	shellDebounceTimer = setTimeout(postShell, 10);
}

postMessage(['init' ]);
