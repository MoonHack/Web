'use strict';

let ws, host, user, canRunCommand;
canRunCommand = false;

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

function refreshToken() {
	sendRequest('post', '/api/v1/auth/refresh');
}
setInterval(refreshToken, 30 * 60 * 1000);

function sendCommand(cmd, args) {
	canRunCommand = false;
	const xhr = sendRequest('post', '/api/v1/run', {
		username: user,
		script: cmd,
		args: args,
	}, () => {
		canRunCommand = true;
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

let isReconnecting = false;
function connectWs() {
	isReconnecting = false;

	ws = new WebSocket('ws://' + host + '/api/v1/notifications');
	
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
						canRunCommand = true;
						break;
					case 'connect':
						if (!msg.ok) {
							postMessage(['reload']);
						} else {
							addContent('Connected to MoonHack');
							refreshToken();
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
		canRunCommand = false;
		addContent('Connection to MoonHack closed: ' + e.code);
		if (!isReconnecting) {
			isReconnecting = true;
			setTimeout(connectWs, 2000);
		}
	};

	ws.onerror = e => {
		canRunCommand = false;
		addContent('Connection to MoonHack errored: ' + e);
		if (!isReconnecting) {
			isReconnecting = true;
			setTimeout(connectWs, 2000);
		}
	};
}

function listUsers() {
	sendRequest('get', '/api/v1/users', null, xhr => {
		addContent(xhr.responseText);
		canRunCommand = true;
	});
}

onmessage = msg => {
	msg = msg.data;
	switch (msg[0]) {
		case 'init':
			host = msg[1];
			isReconnecting = true;
			connectWs();
			break;
		case 'user':
			canRunCommand = false;
			ws.send(msg[1]);
			break;
		case 'lsuser':
			listUsers();
			break;
		case 'mkuser':
			canRunCommand = false;
			sendRequest('post', '/api/v1/users', {
				username: msg[1]
			}, xhr => {
				if (xhr.status >= 200 && xhr.status <= 299) {
					addContent("user created");
				} else {
					addContent("could not create user");
				}
				canRunCommand = true;
			});
			break;
		case 'rmuser':
			canRunCommand = false;
			sendRequest('delete', '/api/v1/users', {
				username: msg[1]
			}, xhr => {
				if (xhr.status >= 200 && xhr.status <= 299) {
					addContent("user retired");
				} else {
					addContent("could not retired user");
				}
				canRunCommand = true;
			});
			break;
		case 'command':
			if (!user) {
				addContent("please select a user first");
				return;
			}
			canRunCommand = false;
			sendCommand(msg[1], msg[2]);
			break;
	}
}

let hardlineTimeEnd = 0, userName = 'N/A', gameState = 'N/A', canInput = false, pingTime = 0, pingLatency = 0, pingInProgress = false;

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

	const hardlineLeft = (hardlineTimeEnd - Date.now()) / 1000;
	postMessage(['status',`
		Account: ${padStatusText(user, 16)} |
		User: ${padStatusText(userName, 32)} |
		Hardline: <span style="color: #${(hardlineLeft > 0) ? ('ff0000;">' + padStatusNumber(hardlineLeft.toFixed(1), 5)) : '00ff00;">&nbsp;Off&nbsp;'}</span> |
		Input: <span style="color: #${canInput ? '00ff00;">yes' : 'ff0000;">no&nbsp;'}</span> |
		Game state: ${padStatusText(gameState, 16)} |
		Ping: <span style="${pingInProgress ? 'color: #ffff00;' : ''}">${padStatusText(pingLatency, 4)}ms</span>
	`,`${(hardlineLeft > 0) ? ('HL ' + Math.floor(hardlineLeft)) : 'CL'} ${canInput ? 'IDL' : 'BSY'} ${userName}@${user} ${gameState} - HMWeb`]);
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

let buffer = '';

function conditionalStatusUpdate() {
	if (hardlineTimeEnd - Date.now() > -1000) {
		updateStatus();
	}
}

setInterval(conditionalStatusUpdate, 100);

postMessage(['init' ]);
