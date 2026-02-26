import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconChevronDown } from './icons';
import styles from './Select.module.scss';

export interface SelectOption {
  value: string;
  label: string;
  /** 可选，用于选项的额外样式（如禁用凭证的黄色） */
  optionClassName?: string;
}

interface SelectProps {
  value: string;
  options: ReadonlyArray<SelectOption>;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  fullWidth?: boolean;
}

export function Select({
  value,
  options,
  onChange,
  placeholder,
  className,
  disabled = false,
  ariaLabel,
  fullWidth = true
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || disabled) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!wrapRef.current?.contains(target) && !(event.target as Element)?.closest?.(`[data-select-dropdown]`)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [disabled, open]);

  useEffect(() => {
    if (open && wrapRef.current) {
      const updateRect = () => {
        const rect = wrapRef.current?.getBoundingClientRect();
        if (rect) {
          setDropdownRect({
            top: rect.bottom + 6,
            left: rect.left,
            width: Math.max(rect.width, 320),
          });
        }
      };
      updateRect();
      window.addEventListener('scroll', updateRect, true);
      window.addEventListener('resize', updateRect);
      return () => {
        window.removeEventListener('scroll', updateRect, true);
        window.removeEventListener('resize', updateRect);
      };
    } else {
      setDropdownRect(null);
    }
  }, [open]);

  const isOpen = open && !disabled;

  const selected = options.find((o) => o.value === value);
  const displayText = selected?.label ?? placeholder ?? '';
  const isPlaceholder = !selected && placeholder;

  const dropdownContent = isOpen && dropdownRect && typeof document !== 'undefined' && (
    <div
      data-select-dropdown
      className={styles.dropdown}
      role="listbox"
      aria-label={ariaLabel}
      style={{
        position: 'fixed',
        top: dropdownRect.top,
        left: dropdownRect.left,
        width: dropdownRect.width,
        zIndex: 10000,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="option"
            aria-selected={active}
            className={`${styles.option} ${active ? styles.optionActive : ''} ${opt.optionClassName ?? ''}`}
            onClick={() => {
              onChange(opt.value);
              setOpen(false);
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );

  return (
    <div
      className={`${styles.wrap} ${fullWidth ? styles.wrapFullWidth : ''} ${className ?? ''}`}
      ref={wrapRef}
    >
      <button
        type="button"
        className={`${styles.trigger} ${selected?.optionClassName ?? ''}`}
        onClick={disabled ? undefined : () => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        disabled={disabled}
      >
        <span className={`${styles.triggerText} ${isPlaceholder ? styles.placeholder : ''}`}>
          {displayText}
        </span>
        <span className={styles.triggerIcon} aria-hidden="true">
          <IconChevronDown size={14} />
        </span>
      </button>
      {dropdownContent && createPortal(dropdownContent, document.body)}
    </div>
  );
}
