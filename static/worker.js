'use strict';

let ws, host, protocol, user, canRunCommand;
setCanRunCommand(false);

function setCanRunCommand(can) {
	canRunCommand = can;
	updateStatus();
}

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
	sendRequest('post', '/api/v1/auth/refresh', null, cb);
}
setInterval(refreshToken, 30 * 60 * 1000);

function sendCommand(cmd, args) {
	setCanRunCommand(false);
	const xhr = sendRequest('post', '/api/v1/run', {
		username: user,
		script: cmd,
		args: args,
	}, () => {
		setCanRunCommand(true);
	});
	let lastProgress = 0;
	let buffer = '';
	function handleProgress(pe) {
		const added = xhr.responseText.substr(lastProgress);
		buffer += added;
		let i;
		while ((i = buffer.indexOf('\n')) >= 0) {
			addContent(buffer.substr(0, i));
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
						} else {
							addContent('Switched user to ' + msg.user);
							user = msg.user;
						}
						setCanRunCommand(true);
						break;
					case 'connect':
						if (!msg.ok) {
							postMessage(['reload']);
						} else {
							addContent('Connected to MoonHack');
							if (user) {
								ws.send(user);
							} else {
								listUsers();
							}
						}
						break;
				}
				break;
		}
	};

	ws.onopen = () => {
		addContent('Connection to MoonHack initialized');
	};

	ws.onclose = e => {
		setCanRunCommand(false);
		addContent('Connection to MoonHack closed: ' + e.code);
		setTimeout(() => connectWs(_ws), 2000);
	};

	ws.onerror = e => {
		setCanRunCommand(false);
		addContent('Connection to MoonHack errored: ' + e);
		setTimeout(() => connectWs(_ws), 2000);
	};
}

function listUsers() {
	sendRequest('get', '/api/v1/users', null, xhr => {
		addContent(xhr.responseText);
		setCanRunCommand(true);
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
			ws.send(msg[1]);
			break;
		case 'lsuser':
			listUsers();
			break;
		case 'mkuser':
			setCanRunCommand(false);
			sendRequest('post', '/api/v1/users', {
				username: msg[1]
			}, xhr => {
				if (xhr.status >= 200 && xhr.status <= 299) {
					addContent("user created");
				} else {
					addContent("could not create user");
				}
				ws.close();
				connectWs(ws);
				setCanRunCommand(true);
			});
			break;
		case 'rmuser':
			setCanRunCommand(false);
			sendRequest('delete', '/api/v1/users', {
				username: msg[1]
			}, xhr => {
				if (xhr.status >= 200 && xhr.status <= 299) {
					addContent("user retired");
				} else {
					addContent("could not retired user");
				}
				ws.close();
				connectWs(ws);
				setCanRunCommand(true);
			});
			break;
		case 'command':
			if (!user) {
				addContent("please select a user first");
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

function addContent(content) {
	shellContent.push(content);
	if (shellDebounceTimer !== null) {
		clearTimeout(shellDebounceTimer);
	}
	shellDebounceTimer = setTimeout(postShell, 10);
}

postMessage(['init' ]);
