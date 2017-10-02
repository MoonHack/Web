'use strict';

function initialize() {
	const sCanvas = document.getElementById('shellCanvas');
	const gl = sCanvas.getContext('webgl');
	const sStatus = document.getElementById('statusContainer');

	const sTmpCanvas = document.getElementById('textTempCanvas');
	const sTmpCanvasCtx = sTmpCanvas.getContext('2d');

	const worker = new Worker('static/worker.js');

	let user = '', canInput = false;

	const dpiScalingFactor = 1;

	const cursorHeight = 4 * dpiScalingFactor;
	const lineHeight = 16 * dpiScalingFactor;
	const lineSpacing = 0 * dpiScalingFactor;
	const charWidth = 9 * dpiScalingFactor;
	const totalLineHeight = lineHeight + lineSpacing;

	let lineCount;
	let charsPerLine;

	let commandHistoryPos = 0;
	let commandHistory = [];

	let cursorBlinkOn = true;
	let cursorPos = 0;
	let typedText = '';
	let cliText = [];
	let cliTextSplit = [];
	let lineBuffer = [];
	let lineArrayBuffers = [];
	let renderQueued = false;
	let cliTextSplitDirty = true;
	let needsResize = false;
	let cliScrollOffset = 0;

	let texturesToPurge = [];

	const program = webglUtils.createProgramFromScripts(gl, ['2d-vertex-shader','2d-fragment-shader']);
	gl.useProgram(program);
	const aPosition = gl.getAttribLocation(program, 'a_position');
	const aTexPosition = gl.getAttribLocation(program, 'a_tex_position');
	const uResolution = gl.getUniformLocation(program, 'u_resolution');
	const uTexture = gl.getUniformLocation(program, 'u_texture');
	const uFixedColor = gl.getUniformLocation(program, 'u_fixedcolor');

	// 101215 rgb(16, 18, 21)
	gl.clearColor(16.0/255.0, 18.0/255.0, 21.0/255.0, 1.0);

	const posBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
	gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 0);
	gl.enableVertexAttribArray(aPosition);

	function cursorBlink() {
		cursorBlinkOn = !cursorBlinkOn;
		queueRender();
	}
	let cursorBlinkInterval = setInterval(cursorBlink, 1000);
	function cursorForceOn() {
		clearInterval(cursorBlinkInterval);
		cursorBlinkInterval = setInterval(cursorBlink, 1000);
		if (!cursorBlinkOn) {
			cursorBlinkOn = true;
			queueRender();
		}
	}

	function purgeTextures(arr) {
		for(let i = 0; i < arr.length; i++) {
			const o = arr[i];
			if (o[1]) {
				texturesToPurge.push(o[1]);
			}
		}
	}

	function wrapText(str) {
		let formatting = [];
		let inCC = false;
		let _cc = '';
		let _str = '';
		let _line = [];
		let _lineLen = 0;
		const _lines = [];
		for (let i = 0; i < str.length; i++) {
			const c = str[i];
			if (inCC) {
				if (c === '>') {
					inCC = false;
					if (_cc == '/') {
						formatting.shift();	
					} else {
						formatting.unshift(_cc);
					}
				}
				_cc += c;
			} else if (c === '<') {
				inCC = true;
				_cc = '';
				_line.push([_str,formatting[0]]);
				_lineLen += _str.length;
				_str = '';
			} else {
				_str += c;
				if (_str.length >= charsPerLine - _lineLen) {
					_line.push([_str,formatting[0]]);
					_lineLen += _str.length;
					_str = '';
				}
			}
			if (_lineLen >= charsPerLine) {
				_lines.push([_line, null]);
				_line = [];
				_lineLen = 0;
			}
		}
		if (_str.length > 0) {
			_line.push([_str, formatting[0]]);
		}
		if (_line.length > 0) {
			_lines.push([_line, null]);
		}
		return _lines;
	}

	function recomputeView() {
		cliTextSplitDirty = true;
		cursorForceOn();
	}

	function recomputeLines() {
		let newCliScreenView = [];
		for (let i = 0; i < cliText.length; i++) {
			const data = wrapText(cliText[i]);
			newCliScreenView = newCliScreenView.concat(data);
		}
		purgeTextures(cliTextSplit);
		cliTextSplit = newCliScreenView;
		recomputeView();
	}

	function resize() {
		const width = document.body.clientWidth - 9*2;
		const height = document.body.clientHeight - (9 + 36);

		sCanvas.width = width;
		sCanvas.height = height;
		sTmpCanvas.width = width;
		sTmpCanvas.height = lineHeight;
		gl.uniform2f(uResolution, sCanvas.width, sCanvas.height);
		gl.viewport(0, 0, sCanvas.width, sCanvas.height);

		lineCount = (height / totalLineHeight) - 1; // Reserve 2 line for prompt
		if (lineCount % 1 < 0.5) {
			lineCount--;
		}
		lineCount = Math.floor(lineCount);
		charsPerLine = Math.floor(width / charWidth);

		const bData = [];
		let y = 0;
		for(let i = 0; i < lineCount + 1; i++) {
			bData.push(
				0, y,
				width, y,
				0, y  + totalLineHeight,
				width, y + totalLineHeight
			);
			y += totalLineHeight;
		}
		bData.push(
			0, y,
			width, y,
			0, y  + (lineHeight/2),
			width, y + (lineHeight/2)
		);
		gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
		gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(bData), gl.STATIC_DRAW);

		recomputeLines();
		worker.postMessage(['resize', charsPerLine, lineCount]);
	}

	const texPosBuffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, texPosBuffer);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
		0, 0,
		1, 0,
		0, 1,
		1, 1
	]), gl.STATIC_DRAW);
	gl.vertexAttribPointer(
        aTexPosition,
        2,
        gl.FLOAT,
        false,
        0,
		0);
	gl.enableVertexAttribArray(aTexPosition);

	function renderTextToTexture(text, cb) {
		sTmpCanvasCtx.fillStyle = '#101215';
		sTmpCanvasCtx.fillRect(0, 0, sTmpCanvas.width, sTmpCanvas.height);
		sTmpCanvasCtx.font = '16px white_rabbitregular';
		sTmpCanvasCtx.textBaseline = 'top';
		let x = 0;
		for (let i = 0; i < text.length; i++) {
			const t = text[i];
			if (!t|| !t[0]) {
				continue;
			}
			sTmpCanvasCtx.fillStyle = t[1] || '#77AEEE';
			sTmpCanvasCtx.fillText(t[0], x, 0);
			x += t[0].length * charWidth;
		}
		if (cb) cb(sTmpCanvasCtx);
		gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sTmpCanvas);
	}

	const promptTexture = gl.createTexture();
	gl.activeTexture(gl.TEXTURE1);
	gl.bindTexture(gl.TEXTURE_2D, promptTexture);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
	gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);

	let r_lastTypedText, r_lastUser, r_lastCursorBlinkOn, r_lastCanInput;

	function render() {
		renderQueued = false;
		if (needsResize) {
			resize();
			needsResize = false;
		}

		for (let i = 0; i < texturesToPurge.length; i++) {
			gl.deleteTexture(texturesToPurge[i]);
		}
		texturesToPurge = [];

		const width = gl.canvas.width;

		gl.clear(gl.COLOR_BUFFER_BIT);

		gl.activeTexture(gl.TEXTURE0);
		gl.uniform1i(uTexture, 0);

		const renderLineStart = Math.max(0, cliTextSplit.length - (cliScrollOffset + lineCount));
		const renderLineEnd = Math.min(renderLineStart + lineCount, cliTextSplit.length);

		if (cliTextSplitDirty) {
			for (let i = 0; i < renderLineStart; i++) {
				const t = cliTextSplit[i][1];
				if (t) {
					cliTextSplit[i][1] = null;
					gl.deleteTexture(t);
				}
			}

			for (let i = renderLineEnd; i < cliTextSplit.length; i++) {
				const t = cliTextSplit[i][1];
				if (t) {
					cliTextSplit[i][1] = null;
					gl.deleteTexture(t);
				}
			}
			cliTextSplitDirty = false;
		}

		let y = 0;
		for (let i = renderLineStart; i < renderLineEnd; i++) {
			const currentView = cliTextSplit[i];
			if (!currentView[1]) {
				currentView[1] = gl.createTexture();
				gl.bindTexture(gl.TEXTURE_2D, currentView[1]);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
				gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);	
				renderTextToTexture(currentView[0]);
			} else {
				gl.bindTexture(gl.TEXTURE_2D, currentView[1]);
			}

			gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 2*4*4 * y);
			gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
			y++;
		}
		
		gl.activeTexture(gl.TEXTURE1);
		gl.uniform1i(uTexture, 1);
		if (r_lastTypedText !== typedText || r_lastUser !== user || r_lastCursorBlinkOn !== cursorBlinkOn || r_lastCanInput != canInput) {
			let _r_txt = '$ ';
			let _r_cursorPos = cursorPos + 2 + user.length;
			let _r_activeLine = null;
			if (!canInput) {
				if (typedText === '') {
					_r_activeLine = [];
					_r_cursorPos = 0;
				} else {
					_r_txt = '% ';
				}
			}
			if (!_r_activeLine) {
				_r_activeLine = [[user], [_r_txt], [typedText]];
			}

			renderTextToTexture(_r_activeLine, (ctx) => {
				if (cursorBlinkOn) {
					ctx.fillRect(charWidth * _r_cursorPos, totalLineHeight - cursorHeight, charWidth, cursorHeight);
				}
			});
			r_lastTypedText = typedText;
			r_lastUser = user;
			r_lastCursorBlinkOn = cursorBlinkOn;
		}
		gl.vertexAttribPointer(aPosition, 2, gl.FLOAT, false, 0, 2*4*4 * y);
		gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
	}

	function queueRender() {
		if (renderQueued) {
			return;
		}
		renderQueued = true;
		requestAnimationFrame(render);
	}

	function addContent(content) {
		if (typeof content === 'string') {
			content = [content];
		}
		cliText = cliText.concat(content);
		for (let i = content.length - 1; i >= 0; i--) {
			const data = wrapText(content[i]);
			cliTextSplit = cliTextSplit.concat(data);
		}
		recomputeView();
		queueRender();
	}

	function clearContent() {
		cliText = [];
		purgeTextures(cliTextSplit);
		cliTextSplit = [];
		cliTextSplitDirty = true;
		cliScrollOffset = 0;
		queueRender();
	}

	worker.onmessage = msg => {
		msg = msg.data;
		switch(msg[0]) {
			case 'status':
				sStatus.innerHTML = msg[1];
				document.title = msg[2];
				break;
			case 'user':
				user = msg[1];
				break;
			case 'shell':
				msg.shift();
				addContent(msg);
				break;
			case 'canInput':
				canInput = msg[1];
				queueRender();
				break;
			case 'init':
				worker.postMessage(['init', document.location.host, document.location.protocol]);
				break;
			case 'reload':
				document.location.reload();
				break;
		}
	};

	function onmousewheel(e) {
		if (e.deltaY < 0) {
			if (cliScrollOffset < cliTextSplit.length - lineCount) {
				cliScrollOffset++;
			} else {
				return;
			}
		} else if (e.deltaY > 0) {
			if (cliScrollOffset > 0) {
				cliScrollOffset--;
			} else {
				return;
			}
		} else {
			return;
		}
		e.preventDefault();
		queueRender();
	}

	document.addEventListener('DOMMouseScroll',onmousewheel);
	document.addEventListener('mousewheel', onmousewheel);
	document.addEventListener('wheel', onmousewheel);

	document.addEventListener('keydown', e => {
		switch (e.key) {
			case 'Enter':
				if (!canInput) {
					return;
				}
				const t = typedText.trim();
				commandHistory.push(t);
				while (commandHistory.length > 100) {
					commandHistory.shift();	
				}
				commandHistoryPos = commandHistory.length;
				typedText = '';
				cursorPos = 0;
				const i = t.indexOf(' ');
				let cmd, args;
				if (i >= 0) {
					cmd = t.substr(0, i);
					args = t.substr(i + 1);
				} else {
					cmd = t;
					args = '';
				}
				addContent(`${user}$ ${t}`);
				switch (cmd) {
					case 'user':
						if (args !== '') {
							worker.postMessage(['user',args]);
							break;
						}
						worker.postMessage(['lsuser']);
						break;
					case 'create_user':
						worker.postMessage(['mkuser', args]);
						break;
					case 'retire_user':
						worker.postMessage(['rmuser', args]);
						break;
					case 'clear':
						clearContent();
						break;
					default:
						worker.postMessage(['command',cmd,args]);
						break;
				}
				break;
			case 'Backspace':
				if (cursorPos > 0) {
					typedText = typedText.substr(0, cursorPos - 1) + typedText.substr(cursorPos);
					cursorPos--;
				}
				break;
			case 'ArrowLeft':
				if (cursorPos > 0) {
					cursorPos--;
				}
				break;
			case 'ArrowRight':
				if (cursorPos < typedText.length) {
					cursorPos++;
				}
				break;
			case 'ArrowUp':
				if (commandHistoryPos > 0) {
					--commandHistoryPos;
				}
				typedText = commandHistory[commandHistoryPos];
				cursorPos = typedText.length;
				break;
			case 'ArrowDown':
				if (commandHistoryPos < commandHistory.length - 1) {
					++commandHistoryPos;
				} else if (commandHistoryPos >= commandHistory.length) {
					commandHistoryPos = commandHistory.length - 1;
				}
				typedText = commandHistory[commandHistoryPos];
				cursorPos = typedText.length;
				break;
			case 'PageUp':
				if (cliScrollOffset < cliTextSplit.length - lineCount) {
					cliScrollOffset++;
				}
				break;
			case 'PageDown':
				if (cliScrollOffset > 0) {
					cliScrollOffset--;
				}
				break;
			case 'Delete':
				typedText = typedText.substr(0, cursorPos) + typedText.substr(cursorPos + 1);
				break;
			case 'Escape':
				typedText = '';
				cursorPos = 0;
				commandHistoryPos = commandHistory.length;
				break;
			default:
				if (e.key && e.key.length === 1) {
					typedText = typedText.substr(0, cursorPos) + e.key + typedText.substr(cursorPos);
					cursorPos++;
				} else {
					return;
				}
				break;
		}
		e.preventDefault();
		cursorForceOn();
		queueRender();
	});

	needsResize = true;
	window.onresize = () => {
		needsResize = true;
		queueRender();
	};
}