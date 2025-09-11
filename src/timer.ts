import { Notice, moment, TFolder, TFile } from 'obsidian';
import { notificationUrl, whiteNoiseUrl } from './audio_urls';
import { WhiteNoise } from './white_noise';
import PomoTimerPlugin from './main';

const electron = require("electron");

const MILLISECS_IN_MINUTE = 60 * 1000;

export const enum Mode {
	Pomo,
	ShortBreak,
	LongBreak,
	NoTimer
}


export class Timer {
	plugin: PomoTimerPlugin;
	startTime: moment.Moment; /*when currently running timer started*/
	endTime: moment.Moment;   /*when currently running timer will end if not paused*/
	mode: Mode;
	pausedTime: number;  /*time left on paused timer, in milliseconds*/
	paused: boolean;
	autoPaused: boolean;
	pomosSinceStart: number;
	cyclesSinceLastAutoStop: number;
	activeNote: TFile;
	whiteNoisePlayer: WhiteNoise;
	/** Start time of the current pomodoro session across pauses */
	pomoSessionStartTime: moment.Moment | null;

	constructor(plugin: PomoTimerPlugin) {
		this.plugin = plugin;
		this.mode = Mode.NoTimer;
		this.paused = false;
		this.pomosSinceStart = 0;
		this.cyclesSinceLastAutoStop = 0;

			if (this.plugin.settings.whiteNoise === true) {
				this.whiteNoisePlayer = new WhiteNoise(plugin, whiteNoiseUrl);
			}

			this.pomoSessionStartTime = null;
		}

	onRibbonIconClick() {
		if (this.mode === Mode.NoTimer) {  //if starting from not having a timer running/paused
			this.startTimer(Mode.Pomo);
		} else { //if timer exists, pause or unpause
			this.togglePause();
		}
	}

	/*Set status bar to remaining time or empty string if no timer is running*/
	//handling switching logic here, should spin out
	async setStatusBarText(): Promise<string> {
		if (this.mode !== Mode.NoTimer) {
			let timer_type_symbol = "";
			if (this.plugin.settings.emoji === true) {
				timer_type_symbol = "🏖️ ";
				if (this.mode === Mode.Pomo) {
					timer_type_symbol = "🍅 ";
				}
			}

			if (this.paused === true) {
				return timer_type_symbol + millisecsToString(this.pausedTime); //just show the paused time
			} else if (moment().isSameOrAfter(this.endTime)) {
				await this.handleTimerEnd();
			}

			return timer_type_symbol + millisecsToString(this.getCountdown()); //return display value
		} else {
			return ""; //fixes TypeError: failed to execute 'appendChild' on 'Node https://github.com/kzhovn/statusbar-pomo-obsidian/issues/4
		}
	}

	async handleTimerEnd() {
		if (this.mode === Mode.Pomo) { //completed another pomo
			this.pomosSinceStart += 1;

			if (this.plugin.settings.logging === true) {
				await this.logPomo();
			}
		} else if (this.mode === Mode.ShortBreak || this.mode === Mode.LongBreak) {
			this.cyclesSinceLastAutoStop += 1;
		}

		//switch mode
		if (this.plugin.settings.notificationSound === true) { //play sound end of timer
			playNotification();
		}
		if (this.plugin.settings.useSystemNotification === true) { //show system notification end of timer
			showSystemNotification(this.mode, this.plugin.settings.emoji);
		}

		if (this.plugin.settings.autostartTimer === false && this.plugin.settings.numAutoCycles <= this.cyclesSinceLastAutoStop) { //if autostart disabled, pause and allow user to start manually
			this.setupTimer();
			this.autoPaused = true;
			this.paused = true;
			this.pausedTime = this.getTotalModeMillisecs();
			this.cyclesSinceLastAutoStop = 0;
		} else {
			this.startTimer();
		}
	}

	async quitTimer(): Promise<void> {
		// If quitting a running pomodoro early, note it in the log
		if (this.plugin.settings.logging === true && this.mode === Mode.Pomo) {
			try {
				if (!this.endTime || moment().isBefore(this.endTime)) {
					await this.logPomoQuitEarly();
				}
			} catch (e) {
				console.log(e);
			}
		}

		this.mode = Mode.NoTimer;
		this.startTime = moment(0);
		this.endTime = moment(0);
		this.paused = false;
		this.pomosSinceStart = 0;

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.stopWhiteNoise();
		}

		await this.plugin.loadSettings(); //why am I loading settings on quit? to ensure that when I restart everything is correct? seems weird
	}

	pauseTimer(): void {
		this.paused = true;
		this.pausedTime = this.getCountdown();

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.stopWhiteNoise();
		}
	}

	togglePause() {
		if (this.paused === true) {
			this.restartTimer();
		} else if (this.mode !== Mode.NoTimer) { //if some timer running
			this.pauseTimer();
			new Notice("Timer paused.")
		}
	}

	restartTimer(): void {
		if (this.plugin.settings.logActiveNote === true && this.autoPaused === true) {
			this.setLogFile();
			this.autoPaused = false;
		}

		this.setStartAndEndTime(this.pausedTime);
		this.modeRestartingNotification();
		this.paused = false;

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.whiteNoise();
		}
	}

	startTimer(mode: Mode = null): void {
		this.setupTimer(mode);
		this.paused = false; //do I need this?


		// Capture the active note at start so it can be logged later
		this.setLogFile();

		// Log immediately when a pomodoro starts
		if (this.plugin.settings.logging === true && this.mode === Mode.Pomo) {
			this.logPomoStart();
		}

		this.modeStartingNotification();

		if (this.plugin.settings.whiteNoise === true) {
			this.whiteNoisePlayer.whiteNoise();
		}
	}

	private setupTimer(mode: Mode = null) {
		if (mode === null) { //no arg -> start next mode in cycle
			if (this.mode === Mode.Pomo) {
				if (this.pomosSinceStart % this.plugin.settings.longBreakInterval === 0) {
					this.mode = Mode.LongBreak;
				} else {
					this.mode = Mode.ShortBreak;
				}
			} else { //short break, long break, or no timer
				this.mode = Mode.Pomo;
			}
		} else { //starting a specific mode passed to func
			this.mode = mode;
		}

		// When entering a new Pomodoro session, record the session start time
		if (this.mode === Mode.Pomo) {
			this.pomoSessionStartTime = moment();
		}
		this.setStartAndEndTime(this.getTotalModeMillisecs());
	}

	setStartAndEndTime(millisecsLeft: number): void {
		this.startTime = moment(); //start time to current time
		this.endTime = moment().add(millisecsLeft, 'milliseconds');
	}

	/*Return milliseconds left until end of timer*/
	getCountdown(): number {
		let endTimeClone = this.endTime.clone(); //rewrite with freeze?
		return endTimeClone.diff(moment());
	}

	getTotalModeMillisecs(): number {

		switch (this.mode) {
			case Mode.Pomo: {
				return this.plugin.settings.pomo * MILLISECS_IN_MINUTE;
			}
			case Mode.ShortBreak: {
				return this.plugin.settings.shortBreak * MILLISECS_IN_MINUTE;
			}
			case Mode.LongBreak: {
				return this.plugin.settings.longBreak * MILLISECS_IN_MINUTE;
			}
			case Mode.NoTimer: {
				throw new Error("Mode NoTimer does not have an associated time value");
			}
		}
	}



	/**************  Notifications  **************/
	/*Sends notification corresponding to whatever the mode is at the moment it's called*/
	modeStartingNotification(): void {
		let time = this.getTotalModeMillisecs();
		let unit: string;

		if (time >= MILLISECS_IN_MINUTE) { /*display in minutes*/
			time = Math.floor(time / MILLISECS_IN_MINUTE);
			unit = 'minute';
		} else { /*less than a minute, display in seconds*/
			time = Math.floor(time / 1000); //convert to secs
			unit = 'second';
		}

		switch (this.mode) {
			case (Mode.Pomo): {
				new Notice(`Starting ${time} ${unit} pomodoro.`);
				break;
			}
			case (Mode.ShortBreak):
			case (Mode.LongBreak): {
				new Notice(`Starting ${time} ${unit} break.`);
				break;
			}
			case (Mode.NoTimer): {
				new Notice('Quitting pomodoro timer.');
				break;
			}
		}
	}

	modeRestartingNotification(): void {
		switch (this.mode) {
			case (Mode.Pomo): {
				new Notice(`Restarting pomodoro.`);
				break;
			}
			case (Mode.ShortBreak):
			case (Mode.LongBreak): {
				new Notice(`Restarting break.`);
				break;
			}
		}
	}



	/**************  Logging  **************/
	private buildLogText(prefix: string = "", durationMs?: number): string {
		let timestamp = moment().format(this.plugin.settings.logText);
		let logText = prefix ? `${prefix} ${timestamp}` : timestamp;

		// Append duration before the note link when provided
		if (typeof durationMs === 'number' && !isNaN(durationMs) && durationMs >= 0) {
			logText = `${logText} — ${millisecsToString(durationMs)}`;
		}

		// Always place the active note link at the end when enabled
		if (this.plugin.settings.logActiveNote === true && this.activeNote) {
			const linkText = this.plugin.app.fileManager.generateMarkdownLink(this.activeNote, '');
			logText = `${logText} ${linkText}`;
			logText = logText.replace(String.raw`\n`, "\n");
		}

		return logText;
	}

	private async writeLogEntry(logText: string): Promise<void> {
		if (this.plugin.settings.logToDaily === true) { //use today's note
			let file = (await this.plugin.getDailyNoteFile()).path;
			await this.appendFile(file, logText);
		} else { //use file given in settings
			let file = this.plugin.app.vault.getAbstractFileByPath(this.plugin.settings.logFile);

			if (!file || file !instanceof TFolder) { //if no file, create
				console.log("Creating pomodoro log file");
				await this.plugin.app.vault.create(this.plugin.settings.logFile, "");
			}

			await this.appendFile(this.plugin.settings.logFile, logText);
		}
	}

	async logPomo(): Promise<void> {
		let durationMs = this.pomoSessionStartTime ? moment().diff(this.pomoSessionStartTime) : (this.plugin.settings.pomo * MILLISECS_IN_MINUTE);
		const logText = this.buildLogText("[🍅]", durationMs);
		await this.writeLogEntry(logText);
		this.pomoSessionStartTime = null;
	}

	async logPomoStart(): Promise<void> {
		const logText = this.buildLogText("[🍅 Start]");
		await this.writeLogEntry(logText);
	}

	async logPomoQuitEarly(): Promise<void> {
		let baseStart = this.pomoSessionStartTime || this.startTime;
		let durationMs = baseStart ? moment().diff(baseStart) : undefined;
		const logText = this.buildLogText("[🍅 Quit Early]", durationMs);
		await this.writeLogEntry(logText);
		this.pomoSessionStartTime = null;
	}

	//from Note Refactor plugin by James Lynch, https://github.com/lynchjames/note-refactor-obsidian/blob/80c1a23a1352b5d22c70f1b1d915b4e0a1b2b33f/src/obsidian-file.ts#L69
	async appendFile(filePath: string, logText: string): Promise<void> {
		let existingContent = await this.plugin.app.vault.adapter.read(filePath);
		if (existingContent.length > 0) {
			existingContent = existingContent + '\r';
		}
		await this.plugin.app.vault.adapter.write(filePath, existingContent + logText);
	}

	setLogFile(){
		const activeView = this.plugin.app.workspace.getActiveFile();
		if (activeView) {
			this.activeNote = activeView;
		}
	}
}

/*Returns [HH:]mm:ss left on the current timer*/
function millisecsToString(millisecs: number): string {
	let formattedCountDown: string;

	if (millisecs >= 60 * 60 * 1000) { /* >= 1 hour*/
		formattedCountDown = moment.utc(millisecs).format('HH:mm:ss');
	} else {
		formattedCountDown = moment.utc(millisecs).format('mm:ss');
	}

	return formattedCountDown.toString();
}

function playNotification(): void {
	const audio = new Audio(notificationUrl);
	audio.play();
}

function showSystemNotification(mode:Mode, useEmoji:boolean): void {
	let text = "";
	switch (mode) {
		case (Mode.Pomo): {
			let emoji = useEmoji ? "🏖" : ""
			text = `End of the pomodoro, time to take a break ${emoji}`;
			break;
		}
		case (Mode.ShortBreak):
		case (Mode.LongBreak): {
			let emoji = useEmoji ? "🍅" : ""
			text = `End of the break, time for the next pomodoro ${emoji}`;
			break;
		}
		case (Mode.NoTimer): {
			// no system notification needed
			return;
		}
	}
	let emoji = useEmoji ? "🍅" : ""
	let title = `Obsidian Pomodoro ${emoji}`;

	// Show system notification
	const Notification = (electron as any).remote.Notification;
	const n = new Notification({
		title: title,
		body: text,
		silent: true
	});
	n.on("click", () => {
		n.close();
	});
	n.show();
}



