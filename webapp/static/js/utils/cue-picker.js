/**
 * Cue Picker - a searchable dropdown over QLab's live cue list, replacing a
 * native <datalist> (browser-chrome styling that can't be themed, and no
 * room to show a cue's name alongside its number). Purely a UI component -
 * callers fetch cues via CueAPI and hand the array in; this class only
 * knows how to filter/render/keyboard-navigate them.
 */
class CuePicker {
    /**
     * @param {HTMLInputElement} input - the visible text input (also the field submitted with the form)
     * @param {HTMLElement} menu - the dropdown panel element to render matches into
     * @param {Array<{number: string, name: string, listName: string}>} cues
     */
    constructor(input, menu, cues) {
        this.input = input;
        this.menu = menu;
        this.cues = cues
            .filter((cue) => cue.number)
            .sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true, sensitivity: 'base' }));
        this.activeIndex = -1;
        this.matches = [];

        this._onInput = this._onInput.bind(this);
        this._onKeydown = this._onKeydown.bind(this);
        this._onDocumentClick = this._onDocumentClick.bind(this);

        this.input.addEventListener('focus', this._onInput);
        this.input.addEventListener('input', this._onInput);
        this.input.addEventListener('keydown', this._onKeydown);
        document.addEventListener('click', this._onDocumentClick);
    }

    _onInput() {
        const query = this.input.value.trim().toLowerCase();
        this.matches = query
            ? this.cues.filter((cue) =>
                cue.number.toLowerCase().includes(query) ||
                (cue.name || '').toLowerCase().includes(query) ||
                (cue.listName || '').toLowerCase().includes(query))
            : this.cues;
        this.activeIndex = -1;
        this._render();
    }

    _onKeydown(event) {
        if (this.menu.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            this._onInput();
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            this.activeIndex = Math.min(this.activeIndex + 1, this.matches.length - 1);
            this._render();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            this.activeIndex = Math.max(this.activeIndex - 1, 0);
            this._render();
        } else if (event.key === 'Enter') {
            if (this.activeIndex >= 0 && this.matches[this.activeIndex]) {
                event.preventDefault();
                this._select(this.matches[this.activeIndex]);
            }
        } else if (event.key === 'Escape') {
            this._close();
        }
    }

    _onDocumentClick(event) {
        if (!this.menu.contains(event.target) && event.target !== this.input) {
            this._close();
        }
    }

    _select(cue) {
        this.input.value = cue.number;
        this._close();
        this.input.dispatchEvent(new Event('change', { bubbles: true }));
    }

    _close() {
        this.menu.hidden = true;
        this.activeIndex = -1;
    }

    _render() {
        if (this.matches.length === 0) {
            this.menu.innerHTML = '<div class="cue-picker-empty">No matching cues</div>';
            this.menu.hidden = false;
            return;
        }

        this.menu.innerHTML = this.matches.map((cue, index) => `
            <div class="cue-picker-item${index === this.activeIndex ? ' active' : ''}" data-index="${index}">
                <span class="cue-number">${cue.number}</span>
                <span class="cue-name">${cue.name || cue.listName || ''}</span>
            </div>
        `).join('');

        this.menu.querySelectorAll('.cue-picker-item').forEach((item) => {
            item.addEventListener('mousedown', (event) => {
                event.preventDefault();
                this._select(this.matches[parseInt(item.dataset.index, 10)]);
            });
        });

        this.menu.hidden = false;
    }
}
