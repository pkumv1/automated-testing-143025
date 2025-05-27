// Example component for testing
export const Button = ({ onClick, label, disabled = false }) => {
  const handleClick = (e) => {
    if (!disabled) {
      onClick?.(e);
    }
  };

  return (
    <button 
      className="btn-primary"
      onClick={handleClick}
      disabled={disabled}
      data-testid="main-button"
    >
      {label}
    </button>
  );
};

export const validateInput = (value) => {
  if (!value || value.trim() === '') {
    return 'Value is required';
  }
  if (value.length < 3) {
    return 'Value must be at least 3 characters';
  }
  return null;
};